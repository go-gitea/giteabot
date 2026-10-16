import {addLabels, fetchBreakingWithoutLabel, fetchMergedWithLabel, fetchTargeting, removeLabel} from './github.ts';
import {fetchGiteaVersions} from './giteaVersion.ts';

// a relevant label is one that is used to control the merge queue,
// manage backports or any other label that causes the bot to act on
// detection, such as reviewed/* or backport/*
export function isRelevantLabel(label: string): boolean {
  return label.startsWith('reviewed/') || label.startsWith('backport/') || label.startsWith('giteabot/');
}

export async function maintainLabels() {
  const labelsToRemoveAfterMerge = ['reviewed/wait-merge', 'reviewed/prioritize-merge', 'pr/last-call'];
  await Promise.all([
    removeLabelsFromMergedPr(labelsToRemoveAfterMerge),
    removeBackportLabelsFromPrsTargetingReleaseBranches(),
    addKindBreakingToBreakingPrs(),
  ]);
}

// add pr/breaking to all breaking PRs that don't have it
async function addKindBreakingToBreakingPrs() {
  const breakingPrs = await fetchBreakingWithoutLabel();
  return Promise.all(breakingPrs.items.map((pr) => addLabels(pr.number, ['pr/breaking'])));
}

function removeLabelsFromMergedPr(labels: string[]) {
  return Promise.all(labels.map(async (label) => {
    const prs = await fetchMergedWithLabel(label);
    return Promise.all(prs.map((pr) => removeLabel(pr.number, label)));
  }));
}

// for each gitea version, fetch open PRs that target that version and remove
// the backport/* labels from them
async function removeBackportLabelsFromPrsTargetingReleaseBranches() {
  const giteaVersions = await fetchGiteaVersions();
  await Promise.all(giteaVersions.map(async (version) => {
    const prs = await fetchTargeting(`release/v${version.majorMinorVersion}`);
    await Promise.all(prs.flatMap((pr) => pr.labels
      .filter((label) => label.name.startsWith('backport/'))
      .map((label) => removeLabel(pr.number, label.name))));
  }));
}
