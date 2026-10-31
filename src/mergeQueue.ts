import {addComment, enableAutoMerge, fetchMergeQueueState, fetchPendingMerge, fetchPr, removeLabel, type MergeQueueState} from './github.ts';
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
  const queue = await fetchMergeQueueState(prNumber);
  if (queue.isMergeQueueEnabled) return enqueuePr(prNumber, queue);

  const err = await updateBranch(prNumber);

  if (err?.message === 'merge conflicts in PR') {
    // if there is a merge conflict, we'll remove the reviewed/wait-merge label
    await removeLabel(prNumber, 'reviewed/wait-merge');
  }
}

// the queue tests against the latest base itself, so the branch is never updated
async function enqueuePr(prNumber: number, queue: MergeQueueState) {
  if (queue.state !== 'OPEN' || queue.isInMergeQueue || queue.autoMergeRequest) return;

  if (queue.mergeable === 'CONFLICTING') {
    const pr = await fetchPr(prNumber);
    await addComment(prNumber, `@${pr.user.login} please fix the merge conflicts. :tea:`);
    await removeLabel(prNumber, 'reviewed/wait-merge');
    return;
  }

  await enableAutoMerge(prNumber, queue.id);
  console.info(`Queued PR #${prNumber} for merge`);
}
