import {fetchPendingMerge, removeLabel} from './github.ts';
import {updateBranch} from './prActions.ts';

export async function updateMergeQueue() {
  // update all PRs pending merge (only if they need an update)
  for (const pr of await fetchPendingMerge()) {
    try {
      await updateQueuedPr(pr.number);
    } catch (error) {
      console.error(`Failed to update PR #${pr.number}:`, error);
    }
  }
}

export async function updateQueuedPr(prNumber: number) {
  const err = await updateBranch(prNumber);

  if (err?.message === 'merge conflicts in PR') {
    // if there is a merge conflict, we'll remove the reviewed/wait-merge label
    await removeLabel(prNumber, 'reviewed/wait-merge');
  }
}
