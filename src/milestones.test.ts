import {assignMilestone, rolloverReleasedMilestones} from './milestones.ts';

test('rolloverReleasedMilestones() opens the next major once its release branch exists, reuses a concurrently created milestone, closes tagged milestones in version order and moves their open PRs by base branch', async () => {
  const requests: string[] = [];
  const milestones = [
    {title: '29.0.0', number: 3},
    {title: '28.2.0', number: 2},
    {title: '28.1.0', number: 1},
  ];
  const prsByMilestone: Record<string, {number: number; pull_request?: object}[]> = {
    1: [{number: 10, pull_request: {}}],
    3: [{number: 20, pull_request: {}}, {number: 21, pull_request: {}}, {number: 22}],
  };
  const baseByPr: Record<string, string> = {10: 'release/v28', 20: 'main', 21: 'release/v29'};
  vi.stubGlobal('fetch', (url: string, {method = 'GET', body}: {method?: string; body?: string}) => {
    const path = new URL(url).pathname.replace(/^\/repos\/[^/]+\/[^/]+/, '');
    if (method === 'HEAD') {
      const exists = ['/branches/release/v29', '/git/ref/tags/v28.1.0', '/git/ref/tags/v29.0.0'].includes(path);
      return Promise.resolve(new Response(null, {status: exists ? 200 : 404}));
    }
    if (method !== 'GET') {
      requests.push(`${method} ${path} ${body}`);
      if (body === '{"title":"30.0.0"}') {
        milestones.push({title: '30.0.0', number: 5});
        return Promise.resolve(new Response('{}', {status: 422}));
      }
      return Promise.resolve(Response.json({number: 6}));
    }
    if (path === '/issues') return Promise.resolve(Response.json(prsByMilestone[new URL(url).searchParams.get('milestone')!] ?? []));
    if (path.startsWith('/pulls/')) {
      const number = Number(path.split('/').at(-1));
      return Promise.resolve(Response.json({number, base: {ref: baseByPr[number]}}));
    }
    return Promise.resolve(Response.json(milestones));
  });
  const open = await rolloverReleasedMilestones();
  expect(requests).toEqual([
    'POST /milestones {"title":"30.0.0"}',
    'PATCH /issues/10 {"milestone":2}',
    'PATCH /milestones/1 {"state":"closed"}',
    'POST /milestones {"title":"29.1.0"}',
    'PATCH /issues/20 {"milestone":5}',
    'PATCH /issues/21 {"milestone":6}',
    'PATCH /milestones/3 {"state":"closed"}',
  ]);
  expect(open.map((milestone) => milestone.title).toSorted()).toEqual(['28.2.0', '29.1.0', '30.0.0']);
});

test('assignMilestone() maps release/v1.27 to 1.27, release/v28 to the earliest 28.x, main to the highest milestone and skips unknown branches', async () => {
  const assigned: number[] = [];
  vi.stubGlobal('fetch', (_url: string, {method, body}: {method?: string; body: string}) => {
    if (method === 'HEAD') return Promise.resolve(new Response(null, {status: 404}));
    if (method === 'PATCH') {
      assigned.push(JSON.parse(body).milestone);
      return Promise.resolve(Response.json({}));
    }
    return Promise.resolve(Response.json([
      {title: '1.27.4', number: 1},
      {title: '28.1.0', number: 2},
      {title: '28.0.0', number: 3},
      {title: '29.0.0', number: 4},
    ]));
  });
  for (const ref of ['release/v1.27', 'release/v28', 'main', 'release/v1.26']) {
    await assignMilestone({number: 1, base: {ref}});
  }
  expect(assigned).toEqual([1, 3, 4]);
});
