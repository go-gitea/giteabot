import {assignMilestone, rolloverReleasedMilestones} from './milestones.ts';

test('rolloverReleasedMilestones() closes tagged milestones in version order and moves their open PRs to the existing or created next minor milestone', async () => {
  const requests: string[] = [];
  vi.stubGlobal('fetch', (url: string, {method = 'GET', body}: {method?: string; body?: string}) => {
    const path = url.replace(/^.*?\/repos\/[^/]+\/[^/]+/, '');
    if (method === 'HEAD') {
      return Promise.resolve(new Response(null, {status: ['/git/ref/tags/v28.1.0', '/git/ref/tags/v28.2.0'].includes(path) ? 200 : 404}));
    }
    if (method !== 'GET') {
      requests.push(`${method} ${path} ${body}`);
      return Promise.resolve(Response.json({number: 5}));
    }
    if (path.startsWith('/issues')) {
      return Promise.resolve(Response.json(path.includes('milestone=1') ? [{number: 10, pull_request: {}}] : [{number: 20, pull_request: {}}, {number: 21}]));
    }
    return Promise.resolve(Response.json([
      {title: '29.0.0', number: 3},
      {title: '28.2.0', number: 2},
      {title: '28.1.0', number: 1},
    ]));
  });
  await rolloverReleasedMilestones();
  expect(requests).toEqual([
    'PATCH /issues/10 {"milestone":2}',
    'PATCH /milestones/1 {"state":"closed"}',
    'POST /milestones {"title":"28.3.0"}',
    'PATCH /issues/20 {"milestone":5}',
    'PATCH /milestones/2 {"state":"closed"}',
  ]);
});

test('assignMilestone() maps release/v1.27 to 1.27, release/v28 to the earliest 28.x, main to the highest milestone and skips unknown branches', async () => {
  const assigned: number[] = [];
  vi.stubGlobal('fetch', (_url: string, {method, body}: {method?: string; body: string}) => {
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
