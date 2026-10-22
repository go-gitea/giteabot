import {
  backportPrExists,
  fetchCandidates,
  fetchPr,
  fetchPrFileNames,
  getPrReviewers,
  hasCommentsSince,
  needsUpdate,
} from './github.ts';

test('fetchCandidates() retries GitHub search failures', async () => {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(Response.json({message: 'You have exceeded a secondary rate limit.'}, {status: 429, headers: {'Retry-After': '0.001'}}))
    .mockResolvedValueOnce(Response.json({total_count: 1, incomplete_results: false, items: [{number: 123}]}));
  vi.stubGlobal('fetch', fetchMock);
  const result = await fetchCandidates('1.26');
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(result.items).toEqual([{number: 123}]);
});

test('fetchCandidates() throws the GitHub API error payload', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({message: 'Bad credentials'}, {status: 401})));
  await expect(fetchCandidates('1.26')).rejects.toThrow(/Bad credentials/);
});

test('getPrReviewers() returns the appropriate approvers', async () => {
  const prToApproversAndBlockers = {
    8346: { // note lafriks and guillep2k are requested reviewers so they don't count as approvers nor blockers
      approvers: new Set(['silverwind', '6543', 'lunny', 'techknowlogick', 'zeripath', 'sapk', 'BaxAndrei']),
      blockers: new Set(['SuperSandro2000']),
    },
    23993: {
      approvers: new Set(['delvh', 'jolheiser']),
      blockers: new Set<string>(),
    },
    24051: {
      approvers: new Set(['delvh', 'silverwind']),
      blockers: new Set<string>(),
    },
    24047: {
      approvers: new Set(['yardenshoham', 'lunny']),
      blockers: new Set<string>(),
    },
    24055: {approvers: new Set<string>(), blockers: new Set<string>()},
    24147: { // delvh approved and then self-requested review
      approvers: new Set<string>(),
      blockers: new Set<string>(),
    },
    24254: {
      approvers: new Set(['jolheiser', 'yardenshoham']),
      blockers: new Set<string>(),
    },
    24259: {
      approvers: new Set(['jolheiser', 'delvh']),
      blockers: new Set<string>(),
    },
    24270: {
      approvers: new Set(['lunny', 'delvh', 'silverwind']),
      blockers: new Set<string>(),
    },
  };
  await Promise.all(Object.entries(prToApproversAndBlockers).map(async ([prNumber, approversAndBlockers]) => {
    const result = await getPrReviewers(await fetchPr(Number(prNumber)));
    expect(result.approvers).toEqual(approversAndBlockers.approvers);
    expect(result.blockers).toEqual(approversAndBlockers.blockers);
  }));
});

test('getPrReviewers() lifts the block of a reviewer who re-requested their own review', async () => {
  const fetchMock = vi.fn((url: string) => {
    if (url.includes('/reviews')) {
      return Promise.resolve(Response.json([
        {state: 'CHANGES_REQUESTED', user: {login: 'alice'}},
        {state: 'CHANGES_REQUESTED', user: {login: 'bob'}},
        {state: 'CHANGES_REQUESTED', user: {login: 'carol'}},
      ]));
    }
    if (url.includes('/events')) {
      return Promise.resolve(Response.json([
        {event: 'review_requested', requested_reviewer: {login: 'alice'}, review_requester: {login: 'author'}},
        {event: 'review_requested', requested_reviewer: {login: 'alice'}, review_requester: {login: 'alice'}},
        {event: 'review_requested', requested_reviewer: {login: 'bob'}, review_requester: {login: 'bob'}},
        {event: 'review_requested', requested_reviewer: {login: 'bob'}, review_requester: {login: 'author'}},
      ]));
    }
    return Promise.resolve(Response.json({}));
  });
  vi.stubGlobal('fetch', fetchMock);
  const result = await getPrReviewers({number: 1, requested_reviewers: [{login: 'alice'}, {login: 'bob'}]});
  expect(result.blockers).toEqual(new Set(['bob', 'carol']));
  expect(fetchMock.mock.calls.filter(([url]) => url.includes('/events'))).toHaveLength(1);

  await getPrReviewers({number: 1, requested_reviewers: []});
  expect(fetchMock.mock.calls.filter(([url]) => url.includes('/events'))).toHaveLength(1);
});

test('needsUpdate() compares the head against the base branch regardless of maintainer_can_modify', async () => {
  let behindBy = 1;
  vi.stubGlobal('fetch', (url: string) => Promise.resolve(Response.json(url.includes('/compare/release/v28...abc') ? {behind_by: behindBy} : {})));
  const pr = {state: 'open', maintainer_can_modify: false, base: {ref: 'release/v28'}, head: {sha: 'abc'}};
  expect(await needsUpdate(pr)).toBe(true);
  behindBy = 0;
  expect(await needsUpdate(pr)).toBe(false);
});

test('fetchPrFileNames() returns the appropriate files', async () => {
  const prToFiles = {
    25432: new Set([
      'modules/setting/database.go',
      'options/locale/locale_en-US.ini',
      'routers/install/install.go',
      'services/forms/user_form.go',
      'templates/install.tmpl',
    ]),
    24825: new Set(['models/repo/topic.go']),
  };

  await Promise.all(Object.entries(prToFiles).map(async ([prNumber, files]) => {
    expect(await fetchPrFileNames(Number(prNumber))).toEqual(files);
  }));
});

test('fetchPrFileNames() can handle big PRs', async () => {
  const aPrWith669Files = await fetchPrFileNames(24147);
  expect(aPrWith669Files.size).toEqual(669);
});

test('hasCommentsSince() only counts comments created after the given date', async () => {
  expect(await hasCommentsSince(1000, new Date('2017-02-21T14:30:00Z'))).toEqual(true);
  expect(await hasCommentsSince(10, new Date('2017-01-01T00:00:00Z'))).toEqual(false);
  expect(await hasCommentsSince(29, new Date(0))).toEqual(false);
  expect(await hasCommentsSince(24147, new Date('2023-04-18T16:57:30Z'))).toEqual(false);
});

test('backportPrExists() counts a merged backport PR whose fork branch is deleted', async () => {
  vi.stubGlobal('fetch', (url: string) => Promise.resolve(url.includes('/search/issues') ?
    Response.json({total_count: decodeURIComponent(url).includes('is:open') ? 0 : 1}) :
    new Response(null, {status: 404})));
  expect(await backportPrExists({number: 1}, '28')).toBe(true);
});

test('backportPrExists() returns the appropriate result', async () => {
  const prAndVersionToBackportExists = {
    '30511_1.22': true,
    '30511_1.21': true,
    '30511_1.20': false,
  };
  await Promise.all(Object.entries(prAndVersionToBackportExists).map(async ([prAndVersion, backportExists]) => {
    const [prNumber, version] = prAndVersion.split('_');
    expect(await backportPrExists({number: Number(prNumber)}, version)).toEqual(backportExists);
  }));
});
