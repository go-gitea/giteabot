import {deleteBackportBranch, setBackportConflictFreeLabels} from './backport.ts';

test('setBackportConflictFreeLabels() skips PRs without a backport/v* label and removes their stale label', async () => {
  const requests: string[] = [];
  vi.stubGlobal('fetch', (url: string, {method}: {method?: string}) => {
    requests.push(`${method} ${new URL(url).pathname}`);
    return Promise.resolve(Response.json({}));
  });
  await setBackportConflictFreeLabels([{number: 1, labels: [{name: 'backport/conflict-free'}]}, {number: 2, labels: []}]);
  expect(requests).toEqual(['DELETE /repos/go-gitea/gitea/issues/1/labels/backport/conflict-free']);
});

test('deleteBackportBranch() deletes backport branches only in the token user\'s fork', async () => {
  const deleted: string[] = [];
  vi.stubGlobal('fetch', (url: string, {method}: {method?: string}) => {
    if (method === 'DELETE') deleted.push(new URL(url).pathname);
    return Promise.resolve(Response.json({login: 'GiteaBot'}));
  });
  for (const [ref, owner] of [['backport-123-v28', 'GiteaBot'], ['backport-123-v28', 'someone'], ['fix-123', 'GiteaBot']]) {
    await deleteBackportBranch({head: {ref, repo: {full_name: `${owner}/gitea`, owner: {login: owner}}}});
  }
  expect(deleted).toEqual(['/repos/GiteaBot/gitea/git/refs/heads/backport-123-v28']);
});
