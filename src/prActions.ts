import {addComment, needsUpdate, readText, removeLabel, updatePr} from './github.ts';

export async function executePrAction(label: string, pr: {number: number; user: {login: string}}) {
  if (label === 'giteabot/update-branch') {
    const err = await updateBranch(pr);
    if (err) {
      await addComment(
        pr.number,
        `I failed to update the branch because of the following error: ${err.message} Sorry about that. :tea:`,
      );
      return;
    }
    await removeLabel(pr.number, 'giteabot/update-branch');
  }
}

export async function updateBranch(pr: {number: number; user: {login: string}}): Promise<Error | undefined> {
  if (await needsUpdate(pr.number)) {
    const response = await updatePr(pr.number);
    if (response.ok) {
      console.info(`Synced PR #${pr.number}`);
      return undefined;
    }

    const text = await readText(response);
    let body: {message?: string} | null = null;
    try {
      body = JSON.parse(text);
    } catch {
      // non-JSON body, e.g. an HTML error page
    }
    if (body?.message !== 'merge conflict between base and head') {
      console.error(`Failed to sync PR #${pr.number}`);
      console.error(text);
      return new Error(body?.message ?? `HTTP ${response.status}`);
    }

    console.info(`Merge conflict detected in PR #${pr.number}`);
    // if there is a merge conflict, we'll add a comment to fix the conflicts
    await addComment(pr.number, `@${pr.user.login} please fix the merge conflicts. :tea:`);
    return new Error('merge conflicts in PR');
  }
  return undefined;
}
