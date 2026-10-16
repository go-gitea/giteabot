import {fetchPendingMerge, removeLabel} from './github.ts';
import {updateBranch} from './prActions.ts';

export async function updateMergeQueue() {
  // update all PRs pending merge (only if they need an update)
  for (const pr of await fetchPendingMerge()) {
    const err = await updateBranch(pr);

    if (err?.message === 'merge conflicts in PR') {
      // if there is a merge conflict, we'll remove the reviewed/wait-merge label
      await removeLabel(pr.number, 'reviewed/wait-merge');
    }
  }
}
