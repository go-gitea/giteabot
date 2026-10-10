import * as SemVer from 'semver';
import {fetchGiteaVersions} from './giteaVersion.ts';
import * as github from './github.ts';

// given a PR number, set the milestone of the PR according to its base branch
export async function assign(pr: {number: number; base: {ref: string}}) {
  // fetch the current gitea versions
  const giteaVersions = await fetchGiteaVersions();

  // find the gitea version that matches the PR's base branch
  let giteaVersion = giteaVersions.find((version) =>
    pr.base.ref === `release/v${version.majorMinorVersion}`,
  );

  // if no gitea version is found, the PR is targeting the main branch. We
  // will use the gitea version with the highest major and minor version using
  // the semver library (gt function)
  if (!giteaVersion) {
    giteaVersion = giteaVersions[0];
    for (const version of giteaVersions) {
      if (SemVer.gt(version.semver, giteaVersion.semver)) {
        giteaVersion = version;
      }
    }
  }

  const response = await github.setMilestone(
    pr.number,
    giteaVersion.milestoneNumber,
  );
  if (!response.ok) {
    console.error(
      `Failed to set milestone ${giteaVersion.majorMinorVersion} for PR #${pr.number}`,
    );
    console.error(await response.text());
    return;
  }
  console.info(
    `Set milestone ${giteaVersion.majorMinorVersion} for PR #${pr.number}`,
  );
}

export async function run() {
  await removeMilestonesFromUnmergedClosedPrs();
}

// removes milestones from all PRs that are closed and unmerged
async function removeMilestonesFromUnmergedClosedPrs() {
  // get the current open milestones
  const milestones = await github.getMilestones();

  // for each milestone, fetch the PRs that are closed and included in the milestone
  // and remove the milestone each PR
  return Promise.all(milestones.flatMap(async (m) => {
    const prs = await github.fetchUnmergedClosedWithMilestone(m.title);
    return Promise.all(prs.items.map(async (pr) => {
      const response = await github.removeMilestone(pr.number);
      if (!response.ok) {
        console.error(
          `Failed to remove milestone from closed PR #${pr.number}`,
        );
        console.error(await response.text());
        return;
      }
      console.info(`Removed milestone from closed PR #${pr.number}`);
    }));
  }));
}
