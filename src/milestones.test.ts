import {assignMilestone} from './milestones.ts';

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
