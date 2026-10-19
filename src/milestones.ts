import {
  branchExists,
  closeMilestone,
  createMilestone,
  fetchOpenPrsInMilestone,
  fetchPr,
  fetchUnmergedClosedWithMilestone,
  fetchVersionMilestones,
  getMilestones,
  setMilestone,
  tagExists,
  type VersionMilestone,
} from './github.ts';
import {compareVersions, releaseVersion} from './version.ts';

const byVersion = (a: VersionMilestone, b: VersionMilestone) => compareVersions(a.version, b.version);

// main gets the highest milestone, a release branch the earliest one of its version
function milestoneForBranch(milestones: VersionMilestone[], ref: string) {
  const sorted = milestones.toSorted(byVersion);
  return ref === 'main' ? sorted.at(-1) : sorted.find((milestone) => ref === `release/v${releaseVersion(milestone.version)}`);
}

async function addMilestone(milestones: VersionMilestone[], major: number, minor: number) {
  const title = `${major}.${minor}.0`;
  if (milestones.some((milestone) => milestone.title === title)) return;
  milestones.push({title, number: await createMilestone(title), version: {major, minor, patch: 0}});
}

// returns the open milestones after the rollover
export async function rolloverReleasedMilestones() {
  const milestones = await fetchVersionMilestones();
  const sorted = milestones.toSorted(byVersion);
  const highest = sorted.at(-1);
  if (highest && await branchExists(`release/v${releaseVersion(highest.version)}`)) { // main moved on to the next major
    await addMilestone(milestones, highest.version.major + 1, 0);
  }
  for (const milestone of sorted) {
    if (!await tagExists(`v${milestone.title}`)) continue;
    milestones.splice(milestones.indexOf(milestone), 1);
    await addMilestone(milestones, milestone.version.major, milestone.version.minor + 1);
    let allMoved = true;
    for (const {number} of await fetchOpenPrsInMilestone(milestone.number)) { // serial, concurrent writes hit secondary rate limits
      const target = milestoneForBranch(milestones, (await fetchPr(number)).base.ref);
      if (target && !await setMilestone(number, target.number)) allMoved = false;
    }
    if (allMoved && await closeMilestone(milestone.number)) {
      console.info(`Closed milestone ${milestone.title}`);
    }
  }
  return milestones;
}

// given a PR number, set the milestone of the PR according to its base branch
export async function assignMilestone(pr: {number: number; base: {ref: string}}) {
  const milestone = milestoneForBranch(await rolloverReleasedMilestones(), pr.base.ref); // never assign a released milestone
  if (!milestone) {
    console.info(`No milestone matches ${pr.base.ref} for PR #${pr.number}`);
    return;
  }

  if (await setMilestone(pr.number, milestone.number)) {
    console.info(`Set milestone ${milestone.title} for PR #${pr.number}`);
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
