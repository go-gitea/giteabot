import {updateMergeQueue} from './mergeQueue.ts';

test('updateMergeQueue() updates later PRs when an earlier one fails', async () => {
  const updatedPrs: string[] = [];
  vi.stubGlobal('fetch', (url: string) => {
    if (url.includes('/issues?')) return Promise.resolve(Response.json([1, 2].map((number) => ({number, pull_request: {}}))));
    if (url.includes('/compare/main...sha1')) return Promise.resolve(Response.json({message: 'No common ancestor'}, {status: 404}));
    if (url.includes('/compare/')) return Promise.resolve(Response.json({behind_by: 1}));
    if (url.endsWith('/update-branch')) updatedPrs.push(url);
    const number = Number(/\/pulls\/(\d+)/.exec(url)![1]);
    return Promise.resolve(Response.json({number, state: 'open', base: {ref: 'main'}, head: {sha: `sha${number}`}}));
  });
  await updateMergeQueue();
  expect(updatedPrs).toEqual([expect.stringContaining('/pulls/2/update-branch')]);
});
