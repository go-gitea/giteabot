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
  for (let next = minor; ; next++) {
    const title = `${major}.${next}.0`;
    if (milestones.some((milestone) => milestone.title === title)) return;
    if (await tagExists(`v${title}`)) continue;
    milestones.push({title, number: await createMilestone(title), version: {major, minor: next, patch: 0}});
    return;
  }
}

async function removeMilestoneFromUnmergedClosedPrs(title: string) {
  for (const pr of (await fetchUnmergedClosedWithMilestone(title)).items) {
    if (await setMilestone(pr.number, null)) {
      console.info(`Removed milestone from closed PR #${pr.number}`);
    }
  }
}

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
    await removeMilestoneFromUnmergedClosedPrs(milestone.title);
    if (allMoved && await closeMilestone(milestone.number)) {
      console.info(`Closed milestone ${milestone.title}`);
    }
  }
  return milestones;
}

// given a PR number, set the milestone of the PR according to its base branch
export async function assignMilestone(pr: {number: number; base: {ref: string}}) {
  let milestones: VersionMilestone[];
  try {
    milestones = await rolloverReleasedMilestones();
  } catch (error) { // a failed rollover must never block assignment
    console.error('Milestone rollover failed:', error);
    milestones = await fetchVersionMilestones();
  }
  const milestone = milestoneForBranch(milestones, pr.base.ref);
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

  return Promise.all(milestones.map((m) => removeMilestoneFromUnmergedClosedPrs(m.title)));
}
