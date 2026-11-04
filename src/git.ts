import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runCommand} from './cmd.ts';
import {TARGET_REPO_GIT} from './config.ts';

export const getPrBranchName = (prNumber: number, giteaMajorMinorVersion: string) =>
  `backport-${prNumber}-v${giteaMajorMinorVersion}`;

export const isPrBranchName = (branch: string) => /^backport-\d+-v[\d.]+$/.test(branch);

let repoDir = '';

async function git(args: string[], cwd = repoDir) {
  const {code, stdout, stderr} = await runCommand('git', {args, cwd});
  if (code !== 0) throw new Error(`git ${args[0]} failed:\n${stderr}`);
  return stdout.trim();
}

export async function initializeGitRepo(user: string, email: string | null) {
  repoDir = await mkdtemp(join(tmpdir(), 'giteabot-'));
  // a token in the URL breaks pushes with newer curl, see https://github.com/curl/curl/issues/23446
  await git(['clone', '-c', 'credential.helper=!f() { echo username=x-access-token; echo password=$INPUT_GITHUB_TOKEN; }; f', `https://github.com/${process.env.INPUT_GITEA_FORK}.git`, '.']);
  await git(['remote', 'add', 'upstream', TARGET_REPO_GIT]);

  // set the user name and email
  await git(['config', 'user.name', user]);
  // the email might be null if the token doesn't have the user scope,
  // see https://docs.github.com/en/rest/users/users?apiVersion=2022-11-28#get-the-authenticated-user
  await git(['config', 'user.email', email ?? 'teabot@gitea.io']);
}

export async function cherryPickPr(commitHash: string, prNumber: number, giteaMajorMinorVersion: string) {
  // fetch the upstream main branch
  await git(['fetch', 'upstream', 'main']);

  // fetch the upstream release branch
  await git(['fetch', 'upstream', `release/v${giteaMajorMinorVersion}`]);

  // create the backport branch from the upstream release branch
  const branch = getPrBranchName(prNumber, giteaMajorMinorVersion);
  await git(['checkout', `upstream/release/v${giteaMajorMinorVersion}`, '-b', branch]);

  // cherry-pick the PR
  const {code, stdout, stderr} = await runCommand('git', {cwd: repoDir, args: ['cherry-pick', commitHash]});
  if (code !== 0) {
    console.error(`Cherry-pick failed:\n${stdout}\n${stderr}`.trim());
    await runCommand('git', {cwd: repoDir, args: ['cherry-pick', '--abort']});
    return false;
  }

  // push the branch to the fork
  await git(['push', 'origin', branch]);
  return true;
}

// clones the target repo with the given PR heads and returns its latest release branch
export async function cloneTargetRepo(prNumbers: number[]) {
  const dir = await mkdtemp(join(tmpdir(), 'giteabot-'));
  await git(['clone', '--bare', '--filter=blob:none', TARGET_REPO_GIT, '.'], dir);
  await git(['fetch', 'origin', ...prNumbers.map((number) => `+refs/pull/${number}/head:refs/pull/${number}/head`)], dir);
  const release = await git(['for-each-ref', '--sort=-version:refname', '--count=1', '--format=%(refname:short)', 'refs/heads/release/'], dir);
  return {dir, release, releaseTree: await git(['rev-parse', `${release}^{tree}`], dir)};
}

// whether the squashed changes of head apply onto release as a non-empty cherry-pick
export async function isBackportReady({dir, release, releaseTree}: Awaited<ReturnType<typeof cloneTargetRepo>>, head: string) {
  const base = await git(['merge-base', 'main', head], dir);
  const {code, stdout, stderr} = await runCommand('git', {cwd: dir, args: ['merge-tree', '--write-tree', `--merge-base=${base}`, release, head]});
  if (code === 1) return false;
  if (code !== 0) throw new Error(`git merge-tree failed:\n${stderr}`);
  return stdout.trim() !== releaseTree;
}
