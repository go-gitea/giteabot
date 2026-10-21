import {assignMilestone, rolloverReleasedMilestones} from './milestones.ts';

test('rolloverReleasedMilestones() migrates predicted versions to line milestones, releases them as untracked tags and moves open PRs serially', async () => {
  const requests: string[] = [];
  const milestones = [
    {title: '1.26.5', number: 1, state: 'open'},
    {title: '1.27.6', number: 2, state: 'open'},
    {title: '1.27.x', number: 3, state: 'open'},
    {title: '29.0.0', number: 4, state: 'open'},
    {title: '1.26.4', number: 11, state: 'closed'},
    {title: '1.27.4', number: 12, state: 'closed'},
    {title: '29.x', number: 14, state: 'closed'},
  ];
  const tags = ['v1.26.4', 'v1.27.4', 'v1.27.5', 'v29.0.0'];
  const issuesByMilestone: Record<string, {number: number; pull_request?: object}[]> = {
    2: [{number: 30}, {number: 31, pull_request: {}}],
    3: [{number: 10, pull_request: {}}],
    4: [{number: 20, pull_request: {}}, {number: 21, pull_request: {}}, {number: 22}],
  };
  const baseByPr: Record<string, string> = {10: 'release/v1.27', 20: 'main', 21: 'release/v29'};
  let nextNumber = 7;
  let inFlight = 0;
  let maxInFlight = 0;
  vi.stubGlobal('fetch', async (url: string, {method = 'GET', body}: {method?: string; body?: string}) => {
    maxInFlight = Math.max(maxInFlight, ++inFlight);
    await Promise.resolve();
    inFlight--;
    const {pathname, searchParams} = new URL(url);
    const path = pathname.replace(/^\/repos\/[^/]+\/[^/]+/, '');
    if (method === 'HEAD') return new Response(null, {status: path === '/branches/release/v29' ? 200 : 404});
    if (method !== 'GET') {
      requests.push(body ? `${method} ${path} ${body}` : `${method} ${path}`);
      if (body === '{"title":"29.x"}') return new Response('{}', {status: 422});
      return Response.json(method === 'POST' ? {number: nextNumber++} : {});
    }
    if (path === '/git/matching-refs/tags/v') return Response.json(tags.map((tag) => ({ref: `refs/tags/${tag}`})));
    if (path === '/issues') return Response.json(issuesByMilestone[searchParams.get('milestone')!] ?? []);
    if (path === '/search/issues') return Response.json({items: searchParams.get('q')!.includes('milestone:1.27.x') ? [{number: 23}] : []});
    if (path.startsWith('/pulls/')) return Response.json({base: {ref: baseByPr[path.split('/').at(-1)!]}});
    return Response.json(milestones.filter(({state}) => searchParams.get('state') === 'all' || state === 'open'));
  });
  const open = await rolloverReleasedMilestones();
  expect(requests).toEqual([
    'POST /milestones {"title":"30.0.0"}',
    'PATCH /milestones/1 {"title":"1.26.x"}',
    'PATCH /issues/30 {"milestone":3}',
    'PATCH /issues/31 {"milestone":3}',
    'DELETE /milestones/2',
    'PATCH /issues/23 {"milestone":null}',
    'PATCH /milestones/3 {"title":"1.27.5"}',
    'POST /milestones {"title":"1.27.x"}',
    'PATCH /issues/10 {"milestone":8}',
    'PATCH /milestones/3 {"state":"closed"}',
    'POST /milestones {"title":"29.x"}',
    'PATCH /milestones/14 {"state":"open"}',
    'PATCH /issues/20 {"milestone":7}',
    'PATCH /issues/21 {"milestone":14}',
    'PATCH /milestones/4 {"state":"closed"}',
  ]);
  expect(open.map((milestone) => milestone.title).toSorted()).toEqual(['1.26.x', '1.27.x', '29.x', '30.0.0']);
  expect(maxInFlight).toBe(1);
});

test('assignMilestone() maps release branches to their earliest milestone and main to the highest, even when the rollover fails', async () => {
  const assigned: number[] = [];
  vi.stubGlobal('fetch', (_url: string, {method, body}: {method?: string; body: string}) => {
    if (method === 'HEAD') return Promise.resolve(new Response(null, {status: 403}));
    if (method === 'PATCH') {
      assigned.push(JSON.parse(body).milestone);
      return Promise.resolve(Response.json({}));
    }
    return Promise.resolve(Response.json([
      {title: '1.27.x', number: 1, state: 'open'},
      {title: '28.x', number: 2, state: 'open'},
      {title: '28.0.0', number: 3, state: 'open'},
      {title: '29.0.0', number: 4, state: 'open'},
    ]));
  });
  for (const ref of ['release/v1.27', 'release/v28', 'main', 'release/v1.26']) {
    await assignMilestone({number: 1, base: {ref}});
  }
  expect(assigned).toEqual([1, 3, 4]);
});
