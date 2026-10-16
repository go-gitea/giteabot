import {addLabels, fetchBreakingWithoutLabel, fetchMergedWithLabel, fetchTargeting, removeLabel} from './github.ts';
import {fetchGiteaVersions} from './giteaVersion.ts';
import type {PullRequest} from './types.ts';

// a relevant label is one that is used to control the merge queue,
// manage backports or any other label that causes the bot to act on
// detection, such as reviewed/* or backport/*
export function isRelevantLabel(label: string): boolean {
  return label.startsWith('reviewed/') || label.startsWith('backport/') || label.startsWith('giteabot/');
}

export async function run() {
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

async function removeLabelFromMergedPr(pr: {title: string; number: number}, label: string) {
  const response = await removeLabel(pr.number, label);
  if (response.ok) {
    console.info(`Removed ${label} from "${pr.title}" (#${pr.number})`);
  } else {
    console.error(`Failed to remove ${label} from "${pr.title}" (#${pr.number})`);
    console.error(await response.text());
  }
}

function removeLabelsFromMergedPr(labels: string[]) {
  return Promise.all(labels.map(async (label) => {
    const prs = await fetchMergedWithLabel(label);
    return Promise.all(prs.map((pr) => removeLabelFromMergedPr(pr, label)));
  }));
}

// for each gitea version, fetch open PRs that target that version and remove
// the backport/* labels from them
export async function removeBackportLabelsFromPrsTargetingReleaseBranches() {
  const giteaVersions = await fetchGiteaVersions();
  await Promise.all(giteaVersions.map(async (version) => {
    const prs = await fetchTargeting(`release/v${version.majorMinorVersion}`);
    try {
      await removeBackportLabelsFromPrs(prs);
    } catch (error) {
      // we usually get here when GitHub rate limits us
      console.error(error, JSON.stringify(prs));
    }
  }));
}

// given a list of PRs, removes the backport/* labels from them
export function removeBackportLabelsFromPrs(prs: PullRequest[]) {
  return Promise.all(prs.flatMap((pr) => {
    const backportLabels = pr.labels.filter((label) => label.name.startsWith('backport/'));

    return backportLabels.map(async (label) => {
      const response = await removeLabel(pr.number, label.name);
      if (response.ok) {
        console.info(`Removed ${label.name} from "${pr.title}" (#${pr.number})`);
      } else {
        console.error(`Failed to remove ${label.name} from "${pr.title}" (#${pr.number})`);
        console.error(await response.text());
      }
    });
  }));
}
