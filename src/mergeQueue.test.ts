import {leaveMergeQueue, updateMergeQueue} from './mergeQueue.ts';

function queueState(number: number, state: Record<string, unknown> = {}) {
  return Response.json({data: {repository: {pullRequest: {
    id: `PR_${number}`, state: 'OPEN', mergeable: 'MERGEABLE', isMergeQueueEnabled: true, isInMergeQueue: false, autoMergeRequest: null,
    timelineItems: {nodes: []}, ...state,
  }}}});
}

function stubQueue(states: Record<number, Record<string, unknown>[]>, requests: string[]) {
  vi.stubGlobal('fetch', (url: string, options?: {method?: string; body?: string}) => {
    if (url.endsWith('/graphql')) {
      const {query, variables} = JSON.parse(options!.body!);
      const mutation = /^mutation\(\$id: ID!\) \{(\w+)/.exec(query);
      if (mutation) {
        requests.push(`${mutation[1]} ${variables.id}`);
        return Promise.resolve(Response.json({data: {}}));
      }
      return Promise.resolve(queueState(variables.number, states[variables.number].shift()));
    }
    if (url.includes('/issues?')) return Promise.resolve(Response.json(Object.keys(states).map((number) => ({number: Number(number), pull_request: {}}))));
    if (options?.method) requests.push(`${options.method} ${url.replace(/^.*\/repos\/[^/]+\/[^/]+/, '')}`);
    return Promise.resolve(Response.json({number: 4, user: {login: 'author'}}));
  });
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

test('updateMergeQueue() enables auto-merge instead of updating branches and skips PRs the queue removed until relabeled', async () => {
  const waitMergeLabeled = {__typename: 'LabeledEvent', label: {name: 'reviewed/wait-merge'}};
  const removed = {__typename: 'RemovedFromMergeQueueEvent'};
  const requests: string[] = [];
  stubQueue({
    1: [{}],
    2: [{isInMergeQueue: true}],
    3: [{autoMergeRequest: {enabledAt: '2026-10-31T00:00:00Z'}}],
    4: [{mergeable: 'CONFLICTING'}],
    5: [{timelineItems: {nodes: [waitMergeLabeled, removed, {__typename: 'LabeledEvent', label: {name: 'lgtm/done'}}]}}],
    6: [{timelineItems: {nodes: [removed, waitMergeLabeled]}}],
  }, requests);
  await updateMergeQueue();
  expect(requests).toEqual([
    'enablePullRequestAutoMerge PR_1',
    'POST /issues/4/comments',
    'DELETE /issues/4/labels/reviewed/wait-merge',
    'enablePullRequestAutoMerge PR_6',
  ]);
});

test('leaveMergeQueue() dequeues a queued PR and disables its auto-merge', async () => {
  const requests: string[] = [];
  stubQueue({7: [{isInMergeQueue: true}, {autoMergeRequest: {enabledAt: '2026-10-31T00:00:00Z'}}]}, requests);
  await leaveMergeQueue(7, true);
  expect(requests).toEqual([
    'DELETE /issues/7/labels/reviewed/wait-merge',
    'dequeuePullRequest PR_7',
    'disablePullRequestAutoMerge PR_7',
  ]);
});
