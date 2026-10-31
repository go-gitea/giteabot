import {updateMergeQueue} from './mergeQueue.ts';

function queueState(number: number, state: Record<string, unknown>) {
  return Response.json({data: {repository: {pullRequest: {
    id: `PR_${number}`, state: 'OPEN', mergeable: 'MERGEABLE', isMergeQueueEnabled: true, isInMergeQueue: false, autoMergeRequest: null, ...state,
  }}}});
}

test('updateMergeQueue() updates later PRs when an earlier one fails', async () => {
  const updatedPrs: string[] = [];
  vi.stubGlobal('fetch', (url: string, options?: {body?: string}) => {
    if (url.endsWith('/graphql')) return Promise.resolve(queueState(JSON.parse(options!.body!).variables.number, {isMergeQueueEnabled: false}));
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

test('updateMergeQueue() enables auto-merge instead of updating branches when the base has a merge queue', async () => {
  const states: Record<number, Record<string, unknown>> = {
    1: {},
    2: {isInMergeQueue: true},
    3: {autoMergeRequest: {enabledAt: '2026-10-31T00:00:00Z'}},
    4: {mergeable: 'CONFLICTING'},
  };
  const requests: string[] = [];
  vi.stubGlobal('fetch', (url: string, options?: {method?: string; body?: string}) => {
    if (url.endsWith('/graphql')) {
      const {query, variables} = JSON.parse(options!.body!);
      if (query.startsWith('mutation')) {
        requests.push(`auto-merge ${variables.id}`);
        return Promise.resolve(Response.json({data: {}}));
      }
      return Promise.resolve(queueState(variables.number, states[variables.number]));
    }
    if (url.includes('/issues?')) return Promise.resolve(Response.json([1, 2, 3, 4].map((number) => ({number, pull_request: {}}))));
    if (options?.method) requests.push(`${options.method} ${url.replace(/^.*\/repos\/[^/]+\/[^/]+/, '')}`);
    return Promise.resolve(Response.json({number: 4, user: {login: 'author'}}));
  });
  await updateMergeQueue();
  expect(requests).toEqual([
    'auto-merge PR_1',
    'POST /issues/4/comments',
    'DELETE /issues/4/labels/reviewed/wait-merge',
  ]);
});
