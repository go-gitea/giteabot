import {cherryPickPr, getPrBranchName, initializeGitRepo, isPrBranchName} from './git.ts';
import {fetchGiteaVersions, type GiteaVersion} from './giteaVersion.ts';
import {
  addComment,
  addLabels,
  backportPrExists,
  branchExists,
  createBackportPr,
  deleteBranch,
  fetchCandidates,
  fetchCurrentUser,
  fetchPr,
} from './github.ts';
import type {Issue} from './types.ts';

// GitHub only auto-deletes a fork branch when the merger can write to the fork
export async function deleteBackportBranch(pr: {head: {ref: string; repo: {full_name: string; owner: {login: string}} | null}}) {
  if (!isPrBranchName(pr.head.ref) || pr.head.repo?.owner.login !== (await fetchCurrentUser()).login) return;
  if (await deleteBranch(pr.head.repo.full_name, pr.head.ref)) {
    console.info(`Deleted branch ${pr.head.ref} of merged backport`);
  }
}

export async function createBackports() {
  const user = await fetchCurrentUser();
  await initializeGitRepo(user.login, user.email);
  const versions = await fetchGiteaVersions();
  // skip the in-development next-minor milestone (no release branch yet)
  const hasBranch = await Promise.all(versions.map((v) => branchExists(`release/v${v.majorMinorVersion}`)));
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
  const success = await cherryPickPr(originalPr.merge_commit_sha!, originalPr.number, giteaVersion.majorMinorVersion);

  if (!success) {
    const branch = getPrBranchName(originalPr.number, giteaVersion.majorMinorVersion);
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
    await addLabels(originalPr.number, ['backport/manual']);
    return;
  }

  console.info(`Creating backport PR for #${originalPr.number}`);
  await createBackportPr(originalPr, giteaVersion);
}
