import {leaveMergeQueue} from './mergeQueue.ts';

test('leaveMergeQueue() dequeues a queued PR and disables its auto-merge', async () => {
  const states = [{isInMergeQueue: true, autoMergeRequest: null}, {isInMergeQueue: false, autoMergeRequest: {enabledAt: 'x'}}];
  const mutations: string[] = [];
  vi.stubGlobal('fetch', (_url: string, options: {body: string}) => {
    const {query, variables} = JSON.parse(options.body);
    const mutation = /^mutation\(\$id: ID!\) \{(\w+)/.exec(query);
    if (mutation) mutations.push(`${mutation[1]} ${variables.id}`);
    return Promise.resolve(Response.json({data: mutation ? {} : {repository: {pullRequest: {id: 'PR_7', isMergeQueueEnabled: true, ...states.shift()}}}}));
  });
  await leaveMergeQueue(7);
  expect(mutations).toEqual(['dequeuePullRequest PR_7', 'disablePullRequestAutoMerge PR_7']);
});
