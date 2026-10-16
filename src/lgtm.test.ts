import {run} from './lgtm.ts';

const json = (data: unknown) => Promise.resolve(Response.json(data));

function stubGitHub(listIssues: (url: string) => unknown[]) {
  const calls = {prFetches: 0, statusWrites: 0};
  vi.stubGlobal('fetch', (url: string) => {
    if (url.includes('/pulls/1/reviews')) return json([]);
    if (url.includes('/pulls/1')) {
      calls.prFetches++;
      return json({number: 1, title: 't', head: {sha: 'abc'}, labels: [{name: 'lgtm/need 2'}], requested_reviewers: []});
    }
    if (url.includes('/issues?')) return json(listIssues(url));
    if (url.includes('/statuses/')) calls.statusWrites++;
    return json({});
  });
  return calls;
}

test('run() recomputes a PR once when it surfaces under two label queries', async () => {
  const calls = stubGitHub((url) => url.includes('need%202') || url.includes('lgtm%2Fdone') ? [{number: 1, pull_request: {}}] : []);
  await run();
  expect(calls).toEqual({prFetches: 1, statusWrites: 1});
});

test('run(since) skips PRs older than the cutoff, processes newer ones', async () => {
  const calls = stubGitHub((url) => url.includes('need%202') ? [{number: 1, pull_request: {}, updated_at: '2000-01-01T00:00:00Z'}] : []);
  await run(Date.now());
  expect(calls.prFetches).toEqual(0);
  await run(0);
  expect(calls.prFetches).toEqual(1);
});
