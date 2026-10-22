import {setTimeout as sleep} from 'node:timers/promises';
import {getPrBranchName} from './git.ts';
import type {GiteaVersion} from './giteaVersion.ts';
import {backportPrExistsCache} from './state.ts';
import type {Issue, PullRequest, User} from './types.ts';
import {TARGET_REPO} from './config.ts';
import {compareVersions, parseMilestoneVersion, releaseVersion, type Version} from './version.ts';

const GITHUB_API = 'https://api.github.com';
const HEADERS = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${process.env.INPUT_GITHUB_TOKEN}`,
};

type RequestOptions = {method: string; body?: string};

type SearchResults<T> = {
  items: T[];
  total_count: number;
};

export async function readText(response: Response) {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

// give up retrying when the reset is further out than this — short waits only
const MAX_RETRY_DELAY_MS = 60000;
const capOrFail = (ms: number) => ms > MAX_RETRY_DELAY_MS ? null : ms;

function getRetryDelay(response: Response, message: string) {
  const retryAfterHeader = response.headers.get('retry-after');
  const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : NaN;
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return capOrFail(retryAfterSeconds * 1000);
  }

  const rateLimitRemaining = Number(response.headers.get('x-ratelimit-remaining'));
  const rateLimitReset = Number(response.headers.get('x-ratelimit-reset'));
  if (rateLimitRemaining === 0 && Number.isFinite(rateLimitReset) && rateLimitReset > 0) {
    return capOrFail(Math.max(rateLimitReset * 1000 - Date.now(), 1000));
  }

  if (response.status === 429 || (response.status === 403 && message.includes('rate limit'))) {
    return 1000;
  }

  if (response.status >= 500) {
    return 1000;
  }

  return null;
}

const FETCH_MAX_ATTEMPTS = 5;

// fetch that retries rate limits, server errors and network failures. Returns
// the final response with an unread body — non-ok when the failure is not
// retryable or retries are exhausted.
async function fetchWithRetry(url: string, label: string, options?: RequestOptions): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, {headers: HEADERS, ...options});
    } catch (error) {
      if (attempt >= FETCH_MAX_ATTEMPTS) throw error;
      console.warn(`${label} failed on attempt ${attempt}. Retrying in 1000ms.`);
      await sleep(1000);
      continue;
    }
    if (response.ok) return response;

    // only 403 needs the body (rate-limit check); clone to keep it readable
    const message = response.status === 403 ? (await readText(response.clone())).toLowerCase() : '';
    const retryDelay = getRetryDelay(response, message);
    if (attempt >= FETCH_MAX_ATTEMPTS || retryDelay === null) return response;
    console.warn(`${label} failed on attempt ${attempt}. Retrying in ${retryDelay}ms.`);
    await sleep(retryDelay);
  }
}

// parses a response body, throwing a descriptive error on non-ok responses
// and non-JSON bodies (e.g. HTML error pages). Returns null for empty bodies.
async function parseJSON(response: Response, label: string) {
  const text = await readText(response);
  if (!response.ok) {
    throw new Error(`${label} failed: ${response.status} ${text.slice(0, 300)}`);
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned invalid JSON: ${text.slice(0, 300)}`);
  }
}

async function fetchJSON<T>(url: string, label: string, options?: RequestOptions): Promise<{response: Response; json: T}> {
  const response = await fetchWithRetry(url, label, options);
  return {response, json: await parseJSON(response, label)};
}

// fires a mutating request whose result the caller doesn't need, logging
// instead of throwing on failure so one failed write doesn't abort the run
async function mutate(url: string, label: string, options: RequestOptions) {
  const response = await fetchWithRetry(url, label, options);
  if (!response.ok) {
    const text = await readText(response);
    console.error(`${label} failed: ${response.status} ${text.slice(0, 300)}`);
  }
  return response.ok;
}

async function fetchSearchResults<T>(query: string) {
  const {json} = await fetchJSON<SearchResults<T>>(
    `${GITHUB_API}/search/issues?q=${encodeURIComponent(query)}`,
    `GitHub search ${JSON.stringify(query)}`,
  );
  return json;
}

// paginates via the Link header so callers see all results, not just page 1
// core 5000/hr bucket, vs fetchSearchResults' 30/min search bucket
async function fetchList<T>(path: string) {
  const all: T[] = [];
  let url: string | null = `${GITHUB_API}${path}`;
  while (url) {
    const {response, json} = await fetchJSON<T[]>(url, `GitHub list ${url}`);
    all.push(...json);
    const next = /<([^>]+)>[^,]*?\brel="next"/.exec(response.headers.get('link') ?? '');
    url = next?.[1] ?? null;
  }
  return all;
}

// return the current user
export async function fetchCurrentUser() {
  const {json} = await fetchJSON<User>(`${GITHUB_API}/user`, 'GitHub current user');
  return json;
}

// returns a list of PRs that are merged and have the backport label for the current Gitea version
export function fetchCandidates(giteaMajorMinorVersion: string) {
  return fetchSearchResults<Issue>(
    `is:pr is:merged base:main label:backport/v${giteaMajorMinorVersion} -label:backport/done -label:backport/manual repo:${TARGET_REPO}`,
  );
}

type ListIssue = {
  number: number;
  state: 'open' | 'closed';
  title: string;
  updated_at: string;
  user: {login: string};
  labels: {name: string}[];
  pull_request?: {merged_at: string | null};
};

const fetchIssuesByLabel = (state: 'open' | 'closed', label: string, suffix = '') =>
  fetchList<ListIssue>(
    `/repos/${TARGET_REPO}/issues?per_page=100&state=${state}&labels=${encodeURIComponent(label)}${suffix}`,
  );

// returns a list of PRs that are merged and have the given label
export const fetchMergedWithLabel = async (label: string) =>
  (await fetchIssuesByLabel('closed', label)).filter((item) => item.pull_request?.merged_at);

// returns a list of open issues with the given label
export const fetchOpenIssuesWithLabel = async (label: string) =>
  (await fetchIssuesByLabel('open', label)).filter((item) => !item.pull_request);

// returns a list of open PRs with the given label
export const fetchOpenPrsWithLabel = async (label: string) =>
  (await fetchIssuesByLabel('open', label)).filter((item) => item.pull_request);

export const fetchMilestoneIssues = (milestone: number) =>
  fetchList<ListIssue>(`/repos/${TARGET_REPO}/issues?per_page=100&state=all&milestone=${milestone}`);

export async function fetchPrsAfterTag(tag: string, branch: string) {
  const {json} = await fetchJSON<{commits: {sha: string}[]}>(
    `${GITHUB_API}/repos/${TARGET_REPO}/compare/${tag}...${branch}`,
    `GitHub compare ${tag}...${branch}`,
  );
  const prs = new Set<number>();
  for (const {sha} of json.commits) {
    for (const {number} of await fetchList<{number: number}>(`/repos/${TARGET_REPO}/commits/${sha}/pulls`)) prs.add(number);
  }
  return prs;
}

// returns a list of PRs pending merge (have the label reviewed/wait-merge)
export const fetchPendingMerge = async () =>
  (await fetchIssuesByLabel('open', 'reviewed/wait-merge', '&sort=created&direction=asc')).filter((item) => item.pull_request);

// returns a list of all open PRs
export function fetchOpenPrs() {
  return fetchList<PullRequest>(`/repos/${TARGET_REPO}/pulls?per_page=100&state=open`);
}

// returns a list of open PRs that target the given branch
export function fetchTargeting(branch: string) {
  return fetchList<PullRequest>(`/repos/${TARGET_REPO}/pulls?per_page=100&state=open&base=${encodeURIComponent(branch)}`);
}

// returns a list of closed PRs that have the given milestone
export function fetchUnmergedClosedWithMilestone(milestoneTitle: string) {
  return fetchSearchResults<{number: number}>(
    `is:pr is:closed is:unmerged milestone:${milestoneTitle} repo:${TARGET_REPO}`,
  );
}

// returns a list of breaking PRs that don't have the label pr/breaking
export function fetchBreakingWithoutLabel() {
  return fetchSearchResults<{number: number}>(`is:pr "## :warning: BREAKING" -label:pr/breaking repo:${TARGET_REPO}`);
}

// returns a list of files changed in the given PR number
export async function fetchPrFileNames(prNumber: number) {
  const files = await fetchList<{filename: string}>(`/repos/${TARGET_REPO}/pulls/${prNumber}/files?per_page=100`);
  return new Set(files.map((file) => file.filename));
}

// update a given PR with the latest upstream changes by merging HEAD from
// the base branch into the pull request branch
export async function updatePr(prNumber: number) {
  const pr = await fetchPr(prNumber);
  return fetchWithRetry(
    `${GITHUB_API}/repos/${TARGET_REPO}/pulls/${prNumber}/update-branch`,
    `GitHub update branch of PR #${prNumber}`,
    {method: 'PUT', body: JSON.stringify({expected_head_sha: pr.head.sha})},
  );
}

// sets the lgtm commit status unless already current, GitHub rejects more than 1000 statuses per sha and context
export async function setCommitStatus(sha: string, state: 'error' | 'failure' | 'pending' | 'success', description: string) {
  const {json} = await fetchJSON<{statuses: {context: string; state: string; description: string | null}[]}>(
    `${GITHUB_API}/repos/${TARGET_REPO}/commits/${sha}/status?per_page=100`,
    `GitHub combined status of ${sha}`,
  );
  if (json.statuses.some((status) => status.context === 'giteabot/lgtm' && status.state === state && status.description === description)) {
    return false;
  }
  return mutate(`${GITHUB_API}/repos/${TARGET_REPO}/statuses/${sha}`, `GitHub commit status of ${sha}`, {
    method: 'POST',
    body: JSON.stringify({state, context: 'giteabot/lgtm', description}),
  });
}

// throws on non-404 (auth/rate-limit/5xx) — only 404 means "doesn't exist"
async function repoPathExists(path: string, label: string) {
  const response = await fetchWithRetry(`${GITHUB_API}/repos/${TARGET_REPO}/${path}`, label, {method: 'HEAD'});
  if (response.status === 404) return false;
  if (!response.ok) {
    throw new Error(`${label} failed: ${response.status} ${response.statusText}`);
  }
  return true;
}

export const branchExists = (branch: string) => repoPathExists(`branches/${branch}`, `GitHub branch ${branch}`);

export const fetchVersionTags = async () =>
  (await fetchList<{ref: string}>(`/repos/${TARGET_REPO}/git/matching-refs/tags/v`)).map(({ref}) => ref.slice('refs/tags/v'.length));

export function deleteBranch(repo: string, branch: string) {
  return mutate(`${GITHUB_API}/repos/${repo}/git/refs/heads/${branch}`, `GitHub delete branch ${branch} of ${repo}`, {
    method: 'DELETE',
  });
}

// checks if the given PR needs to be updated
export async function needsUpdate(prNumber: number) {
  const pr = await fetchPr(prNumber);

  // if the PR is not open, it doesn't need to be updated
  if (pr.state !== 'open') return false;

  // pr.base.sha is the base tip at the last sync, not the merge base, so it can't tell if the head is behind
  const {json} = await fetchJSON<{behind_by: number}>(
    `${GITHUB_API}/repos/${TARGET_REPO}/compare/${pr.base.ref}...${pr.head.sha}?per_page=1`,
    `GitHub compare ${pr.base.ref}...${pr.head.sha}`,
  );
  return json.behind_by > 0;
}

// given a PR number that has the given label, remove the label
export async function removeLabel(prNumber: number, label: string) {
  const removed = await mutate(
    `${GITHUB_API}/repos/${TARGET_REPO}/issues/${prNumber}/labels/${label}`,
    `GitHub remove label ${label} from #${prNumber}`,
    {method: 'DELETE'},
  );
  if (removed) console.info(`Removed ${label} from #${prNumber}`);
  return removed;
}

// returns the PR
export async function fetchPr(prNumber: number) {
  const {json} = await fetchJSON<PullRequest>(`${GITHUB_API}/repos/${TARGET_REPO}/pulls/${prNumber}`, `GitHub PR #${prNumber}`);
  return json;
}

// sets the milestone of the given PR
export function setMilestone(prNumber: number, milestone: number | null) {
  return mutate(`${GITHUB_API}/repos/${TARGET_REPO}/issues/${prNumber}`, `GitHub milestone of PR #${prNumber}`, {
    method: 'PATCH',
    body: JSON.stringify({milestone}),
  });
}

// returns true if a backport PR exists for the given PR number and Gitea version
export async function backportPrExists(pr: {number: number}, giteaMajorMinorVersion: string) {
  // check the cache first
  const cacheKey = `${pr.number}_${giteaMajorMinorVersion}`;
  if (backportPrExistsCache.has(cacheKey)) {
    return true;
  }

  const searchResults = await fetchSearchResults<{number: number}>(
    `is:pr repo:${TARGET_REPO} base:release/v${giteaMajorMinorVersion} ${pr.number} in:title`, // any state, so merged backports don't need their fork branch
  );
  if (searchResults.total_count > 0) {
    backportPrExistsCache.add(cacheKey);
    return true;
  }

  // also check if a branch that looks like the backport branch (getPrBranchName) exists
  const branchName = getPrBranchName(pr.number, giteaMajorMinorVersion);
  const response = await fetchWithRetry(
    `${GITHUB_API}/repos/${process.env.INPUT_GITEA_FORK}/branches/${branchName}`,
    `GitHub backport branch ${branchName}`,
    {method: 'HEAD'},
  );
  if (response.ok) {
    backportPrExistsCache.add(cacheKey);
    return true;
  }
  return false;
}

type Milestone = {title: string; number: number; state: 'open' | 'closed'};
export type VersionMilestone = Milestone & {version: Version};

export async function fetchVersionMilestones(state: 'open' | 'all' = 'open'): Promise<VersionMilestone[]> {
  const milestones = await fetchList<Milestone>(`/repos/${TARGET_REPO}/milestones?per_page=100&state=${state}`);
  return milestones.flatMap((milestone) => {
    const version = parseMilestoneVersion(milestone.title);
    return version ? {...milestone, version} : [];
  });
}

// get Gitea milestones
export async function getMilestones() {
  // take only the earliest version of each release branch (e.g. 1.19.0, 1.19.1 -> 1.19.0 and 28.0.0, 28.1.0 -> 28.0.0)
  const earliestPatchVersions: Record<string, VersionMilestone> = {};
  for (const milestone of await fetchVersionMilestones()) {
    const key = releaseVersion(milestone.version);
    if (!earliestPatchVersions[key] || compareVersions(milestone.version, earliestPatchVersions[key].version) < 0) {
      earliestPatchVersions[key] = milestone;
    }
  }
  return Object.values(earliestPatchVersions);
}

export async function createMilestone(title: string) {
  const label = `GitHub create milestone ${title}`;
  const response = await fetchWithRetry(`${GITHUB_API}/repos/${TARGET_REPO}/milestones`, label, {
    method: 'POST',
    body: JSON.stringify({title}),
  });
  if (!response.ok) { // a concurrent run may have created it, or someone closed it
    const existing = (await fetchVersionMilestones('all')).find((milestone) => milestone.title === title);
    if (existing?.state === 'closed') await updateMilestone(existing.number, {state: 'open'});
    if (existing) return existing.number;
  }
  const json: Milestone = await parseJSON(response, label);
  return json.number;
}

export function updateMilestone(milestone: number, changes: {title?: string; state?: 'open' | 'closed'}) {
  return mutate(`${GITHUB_API}/repos/${TARGET_REPO}/milestones/${milestone}`, `GitHub update milestone ${milestone}`, {
    method: 'PATCH',
    body: JSON.stringify(changes),
  });
}

export function deleteMilestone(milestone: number) {
  return mutate(`${GITHUB_API}/repos/${TARGET_REPO}/milestones/${milestone}`, `GitHub delete milestone ${milestone}`, {
    method: 'DELETE',
  });
}

type Review = {
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
  user: {login: string};
};

export async function getPrReviewers(pr: {number: number; requested_reviewers?: {login: string}[] | null}) {
  // load all reviews
  const reviews = await fetchList<Review>(`/repos/${TARGET_REPO}/pulls/${pr.number}/reviews?per_page=100`);

  // count approvers and blockers by replaying all reviews (they are already sorted)
  const approvers = new Set<string>();
  const blockers = new Set<string>();
  for (const review of reviews) {
    switch (review.state) {
      case 'APPROVED':
        approvers.add(review.user.login);
        blockers.delete(review.user.login);
        break;
      case 'DISMISSED':
        approvers.delete(review.user.login);
        blockers.delete(review.user.login);
        break;
      case 'CHANGES_REQUESTED':
        approvers.delete(review.user.login);
        blockers.add(review.user.login);
        break;
      case 'COMMENTED':
      case 'PENDING':
        break;
    }
  }

  // any requested reviewers are not approvers
  for (const requestedReviewer of pr.requested_reviewers!) {
    approvers.delete(requestedReviewer.login);
  }

  // a blocker who re-requested their own review has lifted their block
  const requestedBlockers = pr.requested_reviewers!.map((reviewer) => reviewer.login).filter((login) => blockers.has(login));
  if (requestedBlockers.length > 0) {
    const events = await fetchList<{event: string; requested_reviewer?: {login: string}; review_requester?: {login: string}}>(
      `/repos/${TARGET_REPO}/issues/${pr.number}/events?per_page=100`,
    );
    // events are chronological, so the last request per reviewer wins
    const lastRequester = new Map<string, string>();
    for (const event of events) {
      if (event.event === 'review_requested' && event.requested_reviewer && event.review_requester) {
        lastRequester.set(event.requested_reviewer.login, event.review_requester.login);
      }
    }
    for (const login of requestedBlockers) {
      if (lastRequester.get(login) === login) blockers.delete(login);
    }
  }

  return {approvers, blockers};
}

export async function createBackportPr(originalPr: PullRequest, giteaVersion: GiteaVersion) {
  let prDescription = `Backport #${originalPr.number} by @${originalPr.user.login}`;
  if (originalPr.body) {
    prDescription += `\n\n${originalPr.body}`;
  }
  const {json} = await fetchJSON<PullRequest>(
    `${GITHUB_API}/repos/${TARGET_REPO}/pulls`,
    `GitHub create backport PR of #${originalPr.number}`,
    {
      method: 'POST',
      body: JSON.stringify({
        title: `${originalPr.title} (#${originalPr.number})`,
        head: `${process.env.INPUT_GITEA_FORK!.split('/')[0]}:${getPrBranchName(originalPr.number, giteaVersion.majorMinorVersion)}`,
        base: `release/v${giteaVersion.majorMinorVersion}`,
        body: prDescription,
        maintainer_can_modify: true,
      }),
    },
  );

  // filter lgtm/*, backport/*, reviewed/*, size/*, and pr/* labels
  const excludedPrefixes = ['lgtm/', 'backport/', 'reviewed/', 'size/', 'pr/'];
  await addLabels(json.number, originalPr.labels
    .map((label) => label.name)
    .filter((label) => excludedPrefixes.every((prefix) => !label.startsWith(prefix))));

  // set assignee
  await mutate(`${GITHUB_API}/repos/${TARGET_REPO}/issues/${json.number}`, `GitHub assignee of PR #${json.number}`, {
    method: 'PATCH',
    body: JSON.stringify({assignees: [originalPr.user.login]}),
  });

  // request review from original PR approvers
  const {approvers} = await getPrReviewers(originalPr);
  await mutate(
    `${GITHUB_API}/repos/${TARGET_REPO}/pulls/${json.number}/requested_reviewers`,
    `GitHub reviewers of PR #${json.number}`,
    {method: 'POST', body: JSON.stringify({reviewers: [...approvers]})},
  );

  // if the original PR had exactly one backport/* label, add the backport/done label to it
  if (originalPr.labels.filter((label) => label.name.startsWith('backport/')).length === 1) {
    await addLabels(originalPr.number, ['backport/done']);
    console.info(`Added backport/done label to PR #${originalPr.number}`);
  }
}

export async function addLabels(prNumber: number, labels: string[]) {
  await mutate(`${GITHUB_API}/repos/${TARGET_REPO}/issues/${prNumber}/labels`, `GitHub add labels to #${prNumber}`, {
    method: 'POST',
    body: JSON.stringify({labels}),
  });
}

export async function addComment(issueNumber: number, comment: string) {
  const added = await mutate(
    `${GITHUB_API}/repos/${TARGET_REPO}/issues/${issueNumber}/comments`,
    `GitHub comment on #${issueNumber}`,
    {method: 'POST', body: JSON.stringify({body: comment})},
  );
  if (added) console.info(`Added comment to #${issueNumber}`);
}

// locks a given issue
export async function lockIssue(issueNumber: number, reason: 'off-topic' | 'too heated' | 'resolved' | 'spam') {
  const locked = await mutate(
    `${GITHUB_API}/repos/${TARGET_REPO}/issues/${issueNumber}/lock`,
    `GitHub lock issue #${issueNumber}`,
    {method: 'PUT', body: JSON.stringify({lock_reason: reason})},
  );
  if (locked) console.info(`Locked issue #${issueNumber}`);
  return locked;
}

// returns issues that are unlocked, closed and have been closed before the given date. Only the first 30 results are returned.
export function fetchClosedOldIssuesAndPRs(before: Date) {
  // if we ever become a GitHub app, we need to separate the search query into
  // two queries, one for issues and one for PRs, and then merge the results
  return fetchSearchResults<{
    number: number;
    pull_request?: {url: string};
    updated_at: string;
  }>(`is:closed is:unlocked closed:<${before.toISOString()} repo:${TARGET_REPO}`);
}

// this endpoint ignores sort and direction, and its since filters by updated_at, so check created_at too
export async function hasCommentsSince(issueNumber: number, since: Date) {
  const comments = await fetchList<{created_at: string}>(
    `/repos/${TARGET_REPO}/issues/${issueNumber}/comments?per_page=100&since=${since.toISOString()}`,
  );
  return comments.some((comment) => new Date(comment.created_at) > since);
}

// closes the given issue
export function closeIssue(issueNumber: number) {
  return mutate(`${GITHUB_API}/repos/${TARGET_REPO}/issues/${issueNumber}`, `GitHub close issue #${issueNumber}`, {
    method: 'PATCH',
    body: JSON.stringify({state: 'closed'}),
  });
}

// closes the given PR
export function closePr(prNumber: number) {
  return mutate(`${GITHUB_API}/repos/${TARGET_REPO}/pulls/${prNumber}`, `GitHub close PR #${prNumber}`, {
    method: 'PATCH',
    body: JSON.stringify({state: 'closed'}),
  });
}
