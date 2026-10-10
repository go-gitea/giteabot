import {cherryPickPr, getPrBranchName, initializeGitRepo} from './git.ts';
import type {GiteaVersion} from './giteaVersion.ts';
import {fetchGiteaVersions} from './giteaVersion.ts';
import {
  addComment,
  addLabels,
  backportPrExists,
  branchExists,
  createBackportPr,
  fetchCandidates,
  fetchCurrentUser,
  fetchPr,
} from './github.ts';
import type {Issue} from './types.ts';

let initialized = false;
let initializing: Promise<void> | null = null;

async function initializeBackporter() {
  if (initialized) {
    return;
  }
  if (!initializing) {
    initializing = (async () => {
      if (
        !process.env.BACKPORTER_GITEA_FORK ||
        !process.env.BACKPORTER_GITHUB_TOKEN
      ) {
        console.error(
          'BACKPORTER_GITEA_FORK and BACKPORTER_GITHUB_TOKEN must be set',
        );
        return;
      }

      const user = await fetchCurrentUser();
      await initializeGitRepo(user.login, user.email);
      initialized = true;
    })();
  }
  await initializing;
}

export async function run() {
  await initializeBackporter();
  const versions = await fetchGiteaVersions();
  // skip the in-development next-minor milestone (no release branch yet)
  const hasBranch = await Promise.all(
    versions.map((v) => branchExists(`release/v${v.majorMinorVersion}`)),
  );
  for (const [index, giteaVersion] of versions.entries()) {
    if (!hasBranch[index]) continue;
    const candidates = await fetchCandidates(giteaVersion.majorMinorVersion);
    for (const candidate of candidates.items) {
      console.info(`Parsing #${candidate.number}`);
      await parseCandidate(candidate, giteaVersion);
    }
  }
}

async function parseCandidate(candidate: Issue, giteaVersion: GiteaVersion) {
  if (await backportPrExists(candidate, giteaVersion.majorMinorVersion)) {
    console.info(`Backport PR already exists for #${candidate.number}`);
    return;
  }
  const originalPr = await fetchPr(candidate.number);
  console.info(`Cherry-picking #${originalPr.number}`);
  const success = await cherryPickPr(
    originalPr.merge_commit_sha,
    originalPr.number,
    giteaVersion.majorMinorVersion,
  );

  if (!success) {
    const branch = getPrBranchName(
      originalPr.number,
      giteaVersion.majorMinorVersion,
    );
    await addComment(
      originalPr.number,
      `I was unable to create a backport for ${giteaVersion.majorMinorVersion}. @${originalPr.user.login}, please send one manually. :tea:

\`\`\`sh
git fetch origin release/v${giteaVersion.majorMinorVersion}
git switch -c ${branch} FETCH_HEAD
git cherry-pick ${originalPr.merge_commit_sha}
# fix conflicts, then git cherry-pick --continue
\`\`\`
`,
    );
    await addLabels(
      originalPr.number,
      ['backport/manual'],
    );
    return;
  }

  console.info(`Creating backport PR for #${originalPr.number}`);
  await createBackportPr(originalPr, giteaVersion);
}
