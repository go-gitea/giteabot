import {addComment, fetchMergeQueueState, fetchPendingMerge, fetchPr, mutatePr, removeLabel, type MergeQueueState} from './github.ts';
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

  // a PR the queue removed waits for a new commit or a re-added label instead of failing the queue again
  const lastEvent = queue.timelineItems.nodes.findLast((item) => item.__typename !== 'LabeledEvent' || item.label.name === 'reviewed/wait-merge');
  if (lastEvent?.__typename === 'RemovedFromMergeQueueEvent') return;

  if (queue.mergeable === 'CONFLICTING') {
    const pr = await fetchPr(prNumber);
    await addComment(prNumber, `@${pr.user.login} please fix the merge conflicts. :tea:`);
    await removeLabel(prNumber, 'reviewed/wait-merge');
    return;
  }

  await mutatePr('enablePullRequestAutoMerge', prNumber, queue.id);
  console.info(`Queued PR #${prNumber} for merge`);
}

// keeps a PR that lost its approval or its reviewed/wait-merge label from merging through the queue
export async function leaveMergeQueue(prNumber: number, removeWaitMergeLabel: boolean) {
  let queue = await fetchMergeQueueState(prNumber);
  if (!queue.isMergeQueueEnabled) return;

  if (removeWaitMergeLabel) await removeLabel(prNumber, 'reviewed/wait-merge');
  if (queue.isInMergeQueue) {
    await mutatePr('dequeuePullRequest', prNumber, queue.id);
    queue = await fetchMergeQueueState(prNumber);
  }
  if (queue.autoMergeRequest) await mutatePr('disablePullRequestAutoMerge', prNumber, queue.id);
}
