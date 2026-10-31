import {fetchMergeQueueState, mutatePr} from './github.ts';

// keeps a PR that lost its approval from merging through the queue
export async function leaveMergeQueue(prNumber: number) {
  let queue = await fetchMergeQueueState(prNumber);
  if (!queue.isMergeQueueEnabled) return;

  if (queue.isInMergeQueue) {
    await mutatePr('dequeuePullRequest', prNumber, queue.id);
    queue = await fetchMergeQueueState(prNumber);
  }
  if (queue.autoMergeRequest) await mutatePr('disablePullRequestAutoMerge', prNumber, queue.id);
}
