import {setPrStatusAndLabel, sweepLgtmPrs} from './lgtm.ts';

const json = (data: unknown) => Promise.resolve(Response.json(data));

function stubGitHub(listIssues: (url: string) => unknown[]) {
  const calls = {prFetches: 0, statusWrites: 0};
  const statuses: unknown[] = [];
  vi.stubGlobal('fetch', (url: string, options?: {body: string}) => {
    if (url.includes('/pulls/1/reviews')) return json([]);
    if (url.includes('/pulls/1')) {
      calls.prFetches++;
      return json({number: 1, title: 't', head: {sha: 'abc'}, labels: [{name: 'lgtm/need 2'}], requested_reviewers: []});
    }
    if (url.includes('/issues?')) return json(listIssues(url));
    if (url.includes('/commits/abc/status?')) return json({statuses});
    if (url.includes('/statuses/')) {
      calls.statusWrites++;
      statuses.push(JSON.parse(options!.body));
    }
    return json({});
  });
  return calls;
}

test('sweepLgtmPrs() recomputes a PR once when it surfaces under two label queries and skips unchanged statuses', async () => {
  const calls = stubGitHub((url) => url.includes('need%202') || url.includes('lgtm%2Fdone') ? [{number: 1, pull_request: {}}] : []);
  await sweepLgtmPrs();
  expect(calls).toEqual({prFetches: 1, statusWrites: 1});
  await sweepLgtmPrs();
  expect(calls).toEqual({prFetches: 2, statusWrites: 1});
});

test('setPrStatusAndLabel() counts only maintainer reviews and takes a PR that lost its approval out of the merge queue', async () => {
  const roles: Record<string, string> = {maintainer: 'triage', outsider: 'read', blocker: 'read'};
  const reviews = [
    {state: 'APPROVED', user: {login: 'maintainer'}},
    {state: 'APPROVED', user: {login: 'outsider'}},
    {state: 'CHANGES_REQUESTED', user: {login: 'blocker'}},
  ];
  const graphqlCalls: string[] = [];
  const statuses: {description: string}[] = [];
  vi.stubGlobal('fetch', (url: string, options?: {body?: string}) => {
    if (url.endsWith('/graphql')) {
      graphqlCalls.push(JSON.parse(options!.body!).query.split('(')[0]);
      return json({data: {repository: {pullRequest: {id: 'PR_1', isMergeQueueEnabled: true, isInMergeQueue: false, autoMergeRequest: {enabledAt: 'x'}}}}});
    }
    const login = /\/collaborators\/([^/]+)\/permission/.exec(url)?.[1];
    if (login) return json({role_name: roles[login]});
    if (url.includes('/pulls/1/reviews')) return json(reviews);
    if (url.includes('/commits/abc/status?')) return json({statuses: []});
    if (url.includes('/statuses/')) statuses.push(JSON.parse(options!.body!));
    return json({});
  });
  await setPrStatusAndLabel({number: 1, title: 't', head: {sha: 'abc'}, labels: [{name: 'lgtm/done'}], requested_reviewers: []});
  expect(statuses.map((status) => status.description)).toEqual(['Needs one more approval']);
  expect(graphqlCalls).toEqual(['query', 'mutation']);
});

test('sweepLgtmPrs(since) skips PRs older than the cutoff, processes newer ones', async () => {
  const calls = stubGitHub((url) => url.includes('need%202') ? [{number: 1, pull_request: {}, updated_at: '2000-01-01T00:00:00Z'}] : []);
  await sweepLgtmPrs(Date.now());
  expect(calls.prFetches).toEqual(0);
  await sweepLgtmPrs(0);
  expect(calls.prFetches).toEqual(1);
});
