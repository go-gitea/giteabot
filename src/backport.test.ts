import {deleteBackportBranch} from './backport.ts';

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
