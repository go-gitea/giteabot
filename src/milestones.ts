import {
  branchExists,
  createMilestone,
  deleteMilestone,
  fetchMilestoneIssues,
  fetchPr,
  fetchPrsAfterTag,
  fetchUnmergedClosedWithMilestone,
  fetchVersionMilestones,
  fetchVersionTags,
  getMilestones,
  setMilestone,
  updateMilestone,
  type VersionMilestone,
} from './github.ts';
import {compareVersions, lineTitle, parseMilestoneVersion, parseVersion, releaseVersion, type Version} from './version.ts';

const byVersion = (a: {version: Version}, b: {version: Version}) => compareVersions(a.version, b.version);

// main gets the highest milestone, a release branch the earliest one of its version
function milestoneForBranch(milestones: VersionMilestone[], ref: string) {
  const sorted = milestones.toSorted(byVersion);
  return ref === 'main' ? sorted.at(-1) : sorted.find((milestone) => ref === `release/v${releaseVersion(milestone.version)}`);
}

async function addMilestone(milestones: VersionMilestone[], title: string) {
  const existing = milestones.find((milestone) => milestone.title === title);
  if (existing) return existing;
  const milestone = {title, number: await createMilestone(title), state: 'open' as const, version: parseMilestoneVersion(title)!};
  milestones.push(milestone);
  return milestone;
}

async function fetchReleases() {
  return (await fetchVersionTags()).flatMap((title) => {
    const version = parseVersion(title);
    return version ? {title, version} : [];
  }).toSorted(byVersion);
}

async function removeMilestoneFromUnmergedClosedPrs(title: string) {
  for (const pr of (await fetchUnmergedClosedWithMilestone(title)).items) {
    if (await setMilestone(pr.number, null)) {
      console.info(`Removed milestone from closed PR #${pr.number}`);
    }
  }
}

async function releaseMilestone(milestones: VersionMilestone[], milestone: VersionMilestone, release: string) {
  await removeMilestoneFromUnmergedClosedPrs(milestone.title);
  if (release !== milestone.title && !await updateMilestone(milestone.number, {title: release})) return;
  milestones.splice(milestones.indexOf(milestone), 1);
  await addMilestone(milestones, lineTitle(milestone.version));
  const unreleased = await fetchPrsAfterTag(`v${release}`, `release/v${releaseVersion(milestone.version)}`);
  let allMoved = true;
  for (const {number, state, pull_request} of await fetchMilestoneIssues(milestone.number)) { // serial, concurrent writes hit secondary rate limits
    if (!pull_request || (state === 'closed' && !unreleased.has(number))) continue;
    const target = milestoneForBranch(milestones, (await fetchPr(number)).base.ref);
    if (target && !await setMilestone(number, target.number)) allMoved = false;
  }
  if (allMoved && await updateMilestone(milestone.number, {state: 'closed'})) {
    console.info(`Closed milestone ${release}`);
  }
}

async function convertToLine(milestones: VersionMilestone[], milestone: VersionMilestone) {
  const title = lineTitle(milestone.version);
  const line = milestones.find((other) => other.title === title);
  if (!line) {
    if (!await updateMilestone(milestone.number, {title})) return;
    console.info(`Renamed milestone ${milestone.title} to ${title}`);
    milestone.title = title;
    milestone.version = parseMilestoneVersion(title)!;
    return;
  }
  milestones.splice(milestones.indexOf(milestone), 1);
  let allMoved = true;
  for (const {number} of await fetchMilestoneIssues(milestone.number)) {
    if (!await setMilestone(number, line.number)) allMoved = false;
  }
  if (allMoved && await deleteMilestone(milestone.number)) {
    console.info(`Merged milestone ${milestone.title} into ${title}`);
  }
}

export async function rolloverReleasedMilestones() {
  const all = await fetchVersionMilestones('all');
  const titles = new Set(all.map(({title}) => title));
  const milestones = all.filter(({state}) => state === 'open');
  const sorted = milestones.toSorted(byVersion);
  const highest = sorted.at(-1);
  if (highest && await branchExists(`release/v${releaseVersion(highest.version)}`)) { // main moved on to the next major
    await addMilestone(milestones, `${highest.version.major + 1}.0.0`);
  }
  const releasesByLine = Map.groupBy(await fetchReleases(), ({version}) => releaseVersion(version));
  for (const milestone of sorted) {
    const releases = releasesByLine.get(releaseVersion(milestone.version));
    if (!releases) continue; // a line's first release keeps its exact version
    const latest = releases.at(-1)!.title;
    if (releases.some(({title}) => title === milestone.title)) {
      await releaseMilestone(milestones, milestone, milestone.title);
      continue;
    }
    if (milestone.title !== lineTitle(milestone.version)) await convertToLine(milestones, milestone);
    if (milestone.title === lineTitle(milestone.version) && !titles.has(latest)) await releaseMilestone(milestones, milestone, latest);
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
  let milestone = milestoneForBranch(milestones, pr.base.ref);
  if (!milestone) {
    const line = /^release\/v(.+)$/.exec(pr.base.ref)?.[1];
    if (line && parseMilestoneVersion(`${line}.x`)) milestone = await addMilestone(milestones, `${line}.x`);
  }
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
