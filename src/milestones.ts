import {rcompare} from 'semver';
import {fetchGiteaVersions} from './giteaVersion.ts';
import {fetchUnmergedClosedWithMilestone, getMilestones, setMilestone} from './github.ts';

// given a PR number, set the milestone of the PR according to its base branch
export async function assignMilestone(pr: {number: number; base: {ref: string}}) {
  const giteaVersions = await fetchGiteaVersions();

  // main gets the highest gitea version, a release branch the version matching it
  const giteaVersion = pr.base.ref === 'main' ?
    giteaVersions.toSorted((a, b) => rcompare(a.semver, b.semver))[0] :
    giteaVersions.find((version) => pr.base.ref === `release/v${version.majorMinorVersion}`);
  if (!giteaVersion) {
    console.info(`No milestone matches ${pr.base.ref} for PR #${pr.number}`);
    return;
  }

  if (await setMilestone(pr.number, giteaVersion.milestoneNumber)) {
    console.info(`Set milestone ${giteaVersion.majorMinorVersion} for PR #${pr.number}`);
  }
}

// removes milestones from all PRs that are closed and unmerged
export async function removeMilestonesFromUnmergedClosedPrs() {
  // get the current open milestones
  const milestones = await getMilestones();

  // for each milestone, fetch the PRs that are closed and included in the milestone
  // and remove the milestone each PR
  return Promise.all(milestones.map(async (m) => {
    const prs = await fetchUnmergedClosedWithMilestone(m.title);
    return Promise.all(prs.items.map(async (pr) => {
      if (await setMilestone(pr.number, null)) {
        console.info(`Removed milestone from closed PR #${pr.number}`);
      }
    }));
  }));
}
