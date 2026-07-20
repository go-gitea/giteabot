import { lt, parse, valid } from "@std/semver";
import { getPrBranchName } from "./git.ts";
import { GiteaVersion } from "./giteaVersion.ts";
import { backportPrExistsCache } from "./state.ts";
import { Issue, PullRequest } from "./types.ts";
import { TARGET_REPO } from "./config.ts";

const GITHUB_API = "https://api.github.com";
const HEADERS = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${Deno.env.get("BACKPORTER_GITHUB_TOKEN")}`,
};

type SearchResults<T> = {
  items: T[];
  total_count: number;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// give up retrying when the reset is further out than this — short waits only
const MAX_RETRY_DELAY_MS = 60000;
const capOrFail = (ms: number) => ms > MAX_RETRY_DELAY_MS ? null : ms;

const getRetryDelay = (response: Response, message: string) => {
  const retryAfterHeader = response.headers.get("retry-after");
  const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : NaN;
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
    return capOrFail(retryAfterSeconds * 1000);
  }

  const rateLimitRemaining = Number(
    response.headers.get("x-ratelimit-remaining"),
  );
  const rateLimitReset = Number(response.headers.get("x-ratelimit-reset"));
  if (
    rateLimitRemaining === 0 &&
    Number.isFinite(rateLimitReset) &&
    rateLimitReset > 0
  ) {
    return capOrFail(Math.max(rateLimitReset * 1000 - Date.now(), 1000));
  }

  if (
    response.status === 429 ||
    (response.status === 403 && message.includes("rate limit"))
  ) {
    return 1000;
  }

  if (response.status >= 500) {
    return 1000;
  }

  return null;
};

const FETCH_MAX_ATTEMPTS = 5;

// fetch that retries rate limits, server errors and network failures. Returns
// the final response with an unread body — non-ok when the failure is not
// retryable or retries are exhausted.
const fetchWithRetry = async (
  url: string,
  label: string,
  options: RequestInit = {},
): Promise<Response> => {
  for (let attempt = 1;; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, { headers: HEADERS, ...options });
    } catch (error) {
      if (attempt >= FETCH_MAX_ATTEMPTS) throw error;
      console.warn(
        `${label} failed on attempt ${attempt}. Retrying in 1000ms.`,
      );
      await sleep(1000);
      continue;
    }
    if (response.ok) return response;

    // only 403 needs the body (rate-limit check); clone to keep it readable
    const message = response.status === 403
      ? (await response.clone().text().catch(() => "")).toLowerCase()
      : "";
    const retryDelay = getRetryDelay(response, message);
    if (attempt >= FETCH_MAX_ATTEMPTS || retryDelay === null) return response;
    console.warn(
      `${label} failed on attempt ${attempt}. Retrying in ${retryDelay}ms.`,
    );
    await sleep(retryDelay);
  }
};

// parses a response body, throwing a descriptive error on non-ok responses
// and non-JSON bodies (e.g. HTML error pages). Returns null for empty bodies.
const parseJSON = async (response: Response, label: string) => {
  const text = await response.text().catch(() => "");
  if (!response.ok) {
    throw new Error(
      `${label} failed: ${response.status} ${text.slice(0, 300)}`,
    );
  }
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} returned invalid JSON: ${text.slice(0, 300)}`);
  }
};

const fetchJSON = async (
  url: string,
  label: string,
  options?: RequestInit,
) => {
  const response = await fetchWithRetry(url, label, options);
  return { response, json: await parseJSON(response, label) };
};

// fires a mutating request whose result the caller doesn't need, logging
// instead of throwing on failure so one failed write doesn't abort the run
const mutate = async (url: string, label: string, options: RequestInit) => {
  const response = await fetchWithRetry(url, label, options);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    console.error(`${label} failed: ${response.status} ${text.slice(0, 300)}`);
  }
  return response.ok;
};

const fetchSearchResults = async <T>(
  query: string,
): Promise<SearchResults<T>> => {
  const { json } = await fetchJSON(
    `${GITHUB_API}/search/issues?q=${encodeURIComponent(query)}`,
    `GitHub search ${JSON.stringify(query)}`,
  );
  return json;
};

// paginates via the Link header so callers see all results, not just page 1
// core 5000/hr bucket, vs fetchSearchResults' 30/min search bucket
const fetchList = async <T>(path: string): Promise<T[]> => {
  const all: T[] = [];
  let url: string | null = `${GITHUB_API}${path}`;
  while (url) {
    const { response, json } = await fetchJSON(url, `GitHub list ${url}`);
    all.push(...(json as T[]));
    const next = (response.headers.get("link") ?? "")
      .match(/<([^>]+)>[^,]*?\brel="next"/);
    url = next?.[1] ?? null;
  }
  return all;
};

// return the current user
export const fetchCurrentUser = async () => {
  const { json } = await fetchJSON(`${GITHUB_API}/user`, "GitHub current user");
  return json;
};

// returns a list of PRs that are merged and have the backport label for the current Gitea version
export const fetchCandidates = (giteaMajorMinorVersion: string) => {
  return fetchSearchResults<Issue>(
    `is:pr is:merged base:main label:backport/v${giteaMajorMinorVersion} -label:backport/done -label:backport/manual repo:${TARGET_REPO}`,
  );
};

type ListIssue = {
  number: number;
  title: string;
  updated_at: string;
  user: { login: string };
  labels: { name: string }[];
  pull_request?: { merged_at: string | null };
};

const fetchIssuesByLabel = (
  state: "open" | "closed",
  label: string,
  suffix = "",
) =>
  fetchList<ListIssue>(
    `/repos/${TARGET_REPO}/issues?per_page=100&state=${state}&labels=${
      encodeURIComponent(label)
    }${suffix}`,
  );

// returns a list of PRs that are merged and have the given label
export const fetchMergedWithLabel = async (label: string) =>
  (await fetchIssuesByLabel("closed", label))
    .filter((item) => item.pull_request?.merged_at);

// returns a list of open issues with the given label
export const fetchOpenIssuesWithLabel = async (label: string) =>
  (await fetchIssuesByLabel("open", label))
    .filter((item) => !item.pull_request);

// returns a list of open PRs with the given label
export const fetchOpenPrsWithLabel = async (label: string) =>
  (await fetchIssuesByLabel("open", label))
    .filter((item) => item.pull_request);

// returns a list of PRs pending merge (have the label reviewed/wait-merge)
export const fetchPendingMerge = async () =>
  (await fetchIssuesByLabel(
    "open",
    "reviewed/wait-merge",
    "&sort=created&direction=asc",
  )).filter((item) => item.pull_request);

// returns a list of open PRs that target the given branch
export const fetchTargeting = (branch: string): Promise<PullRequest[]> => {
  return fetchList<PullRequest>(
    `/repos/${TARGET_REPO}/pulls?per_page=100&state=open&base=${
      encodeURIComponent(branch)
    }`,
  );
};

// returns a list of closed PRs that have the given milestone
export const fetchUnmergedClosedWithMilestone = (
  milestoneTitle: string,
) => {
  return fetchSearchResults<{ number: number }>(
    `is:pr is:closed is:unmerged milestone:${milestoneTitle} repo:${TARGET_REPO}`,
  );
};

// returns a list of breaking PRs that don't have the label pr/breaking
export const fetchBreakingWithoutLabel = () => {
  return fetchSearchResults<{ number: number }>(
    `is:pr "## :warning: BREAKING" -label:pr/breaking repo:${TARGET_REPO}`,
  );
};

// returns a list of files changed in the given PR number
export const fetchPrFileNames = async (prNumber: number) => {
  const files: { filename: string }[] = [];
  let page = 1;
  while (true) {
    const { json } = await fetchJSON(
      `${GITHUB_API}/repos/${TARGET_REPO}/pulls/${prNumber}/files?per_page=100&page=${page}`,
      `GitHub files of PR #${prNumber}`,
    );
    files.push(...json);
    if (json.length < 100) {
      break;
    }
    page++;
  }
  return new Set(files.map((file) => file.filename));
};

// update a given PR with the latest upstream changes by merging HEAD from
// the base branch into the pull request branch
export const updatePr = async (prNumber: number): Promise<Response> => {
  const pr = await fetchPr(prNumber);
  return fetchWithRetry(
    `${GITHUB_API}/repos/${TARGET_REPO}/pulls/${prNumber}/update-branch`,
    `GitHub update branch of PR #${prNumber}`,
    {
      method: "PUT",
      body: JSON.stringify({ expected_head_sha: pr.head.sha }),
    },
  );
};

// sets a commit status
export const setCommitStatus = (
  sha: string,
  state: "error" | "failure" | "pending" | "success",
  description: string,
) => {
  return fetchWithRetry(
    `${GITHUB_API}/repos/${TARGET_REPO}/statuses/${sha}`,
    `GitHub commit status of ${sha}`,
    {
      method: "POST",
      body: JSON.stringify({
        state,
        context: "giteabot/lgtm",
        description,
      }),
    },
  );
};

// get a target repo branch
export const fetchBranch = async (branch: string) => {
  const { json } = await fetchJSON(
    `${GITHUB_API}/repos/${TARGET_REPO}/branches/${branch}`,
    `GitHub branch ${branch}`,
  );
  return json;
};

// throws on non-404 (auth/rate-limit/5xx) — only 404 means "doesn't exist"
export const branchExists = async (branch: string): Promise<boolean> => {
  const response = await fetchWithRetry(
    `${GITHUB_API}/repos/${TARGET_REPO}/branches/${branch}`,
    `GitHub branch ${branch}`,
    { method: "HEAD" },
  );
  if (response.status === 404) return false;
  if (!response.ok) {
    throw new Error(
      `branchExists(${branch}) failed: ${response.status} ${response.statusText}`,
    );
  }
  return true;
};

// checks if the given PR needs to be updated
export const needsUpdate = async (prNumber: number) => {
  // get the PR and check if its base sha is the same as its base branch
  const pr = await fetchPr(prNumber);

  // if maintainers can't modify the PR, it doesn't need to be updated
  if (!pr.maintainer_can_modify) return false;

  // if the PR is not open, it doesn't need to be updated
  if (pr.state !== "open") return false;

  const base = await fetchBranch(pr.base.ref);
  return pr.base.sha !== base.commit.sha;
};

// given a PR number that has the given label, remove the label
export const removeLabel = (prNumber: number, label: string) => {
  return fetchWithRetry(
    `${GITHUB_API}/repos/${TARGET_REPO}/issues/${prNumber}/labels/${label}`,
    `GitHub remove label ${label} from #${prNumber}`,
    { method: "DELETE" },
  );
};

// returns the PR
export const fetchPr = async (prNumber: number) => {
  const { json } = await fetchJSON(
    `${GITHUB_API}/repos/${TARGET_REPO}/pulls/${prNumber}`,
    `GitHub PR #${prNumber}`,
  );
  return json;
};

// sets the milestone of the given PR
export const setMilestone = (prNumber: number, milestone: number) => {
  return fetchWithRetry(
    `${GITHUB_API}/repos/${TARGET_REPO}/issues/${prNumber}`,
    `GitHub milestone of PR #${prNumber}`,
    { method: "PATCH", body: JSON.stringify({ milestone }) },
  );
};

// removes the milestone of the given PR
export const removeMilestone = (prNumber: number) => {
  return fetchWithRetry(
    `${GITHUB_API}/repos/${TARGET_REPO}/issues/${prNumber}`,
    `GitHub milestone of PR #${prNumber}`,
    { method: "PATCH", body: JSON.stringify({ milestone: null }) },
  );
};

// returns true if a backport PR exists for the given PR number and Gitea version
export const backportPrExists = async (
  pr: { number: number },
  giteaMajorMinorVersion: string,
) => {
  // check the cache first
  const cacheKey = `${pr.number}_${giteaMajorMinorVersion}`;
  if (backportPrExistsCache.has(cacheKey)) {
    return true;
  }

  const searchResults = await fetchSearchResults<{ number: number }>(
    `is:pr is:open repo:${TARGET_REPO} base:release/v${giteaMajorMinorVersion} ${pr.number} in:title`,
  );
  if (searchResults.total_count > 0) {
    backportPrExistsCache.add(cacheKey);
    return true;
  }

  // also check if a branch that looks like the backport branch (getPrBranchName) exists
  const branchName = getPrBranchName(pr.number, giteaMajorMinorVersion);
  const response = await fetchWithRetry(
    `${GITHUB_API}/repos/${
      Deno.env.get("BACKPORTER_GITEA_FORK")
    }/branches/${branchName}`,
    `GitHub backport branch ${branchName}`,
    { method: "HEAD" },
  );
  if (response.ok) {
    backportPrExistsCache.add(cacheKey);
    return true;
  }
  return false;
};

type Milestone = { title: string; number: number };

// get Gitea milestones
export const getMilestones = async (): Promise<Milestone[]> => {
  const { json } = await fetchJSON(
    `${GITHUB_API}/repos/${TARGET_REPO}/milestones`,
    "GitHub milestones",
  );
  const milestones: Milestone[] = json.filter((m: Milestone) => valid(m.title));

  // take only the earliest patch version of each minor version (e.g. 1.19.0, 1.19.1, 1.19.2 -> 1.19.0)
  const earliestPatchVersions: Record<string, Milestone> = {};
  for (const milestone of milestones) {
    const version = parse(milestone.title);
    const key = `${version.major}.${version.minor}`;
    if (
      !earliestPatchVersions[key] ||
      lt(milestone.title, earliestPatchVersions[key].title)
    ) {
      earliestPatchVersions[key] = milestone;
    }
  }

  return Object.values(earliestPatchVersions);
};

export const getPrReviewers = async (
  pr: { number: number; requested_reviewers: { login: string }[] },
): Promise<{ approvers: Set<string>; blockers: Set<string> }> => {
  // load all reviews
  const reviews: {
    state:
      | "APPROVED"
      | "CHANGES_REQUESTED"
      | "COMMENTED"
      | "DISMISSED"
      | "PENDING";
    user: { login: string };
  }[] = [];
  let page = 1;
  while (true) {
    const { json: results } = await fetchJSON(
      `${GITHUB_API}/repos/${TARGET_REPO}/pulls/${pr.number}/reviews?per_page=100&page=${page}`,
      `GitHub reviews of PR #${pr.number}`,
    );
    if (results.length === 0) break;
    reviews.push(...results);
    page++;
  }

  // count approvers and blockers by replaying all reviews (they are already sorted)
  const approvers = new Set<string>();
  const blockers = new Set<string>();
  for (const review of reviews) {
    switch (review.state) {
      case "APPROVED":
        approvers.add(review.user.login);
        blockers.delete(review.user.login);
        break;
      case "DISMISSED":
        approvers.delete(review.user.login);
        blockers.delete(review.user.login);
        break;
      case "CHANGES_REQUESTED":
        approvers.delete(review.user.login);
        blockers.add(review.user.login);
        break;
      default:
        break;
    }
  }

  // any requested reviewers are not approvers
  for (const requestedReviewer of pr.requested_reviewers) {
    approvers.delete(requestedReviewer.login);
  }

  return { approvers, blockers };
};

export const createBackportPr = async (
  originalPr: {
    title: string;
    number: number;
    body: string;
    labels: [{ name: string }];
    user: { login: string };
    requested_reviewers: { login: string }[];
  },
  giteaVersion: GiteaVersion,
) => {
  let prDescription =
    `Backport #${originalPr.number} by @${originalPr.user.login}`;
  if (originalPr.body) {
    prDescription += "\n\n" + originalPr.body;
  }
  const { json } = await fetchJSON(
    `${GITHUB_API}/repos/${TARGET_REPO}/pulls`,
    `GitHub create backport PR of #${originalPr.number}`,
    {
      method: "POST",
      body: JSON.stringify({
        title: `${originalPr.title} (#${originalPr.number})`,
        head: `${Deno.env.get("BACKPORTER_GITEA_FORK")?.split("/")[0]}:${
          getPrBranchName(
            originalPr.number,
            giteaVersion.majorMinorVersion,
          )
        }`,
        base: `release/v${giteaVersion.majorMinorVersion}`,
        body: prDescription,
        maintainer_can_modify: true,
      }),
    },
  );

  // filter lgtm/*, backport/*, reviewed/*, size/*, and pr/* labels
  const labels = originalPr.labels
    .map((label) => label.name)
    .filter((label) => {
      return (
        !label.startsWith("lgtm/") &&
        !label.startsWith("backport/") &&
        !label.startsWith("reviewed/") &&
        !label.startsWith("size/") &&
        !label.startsWith("pr/")
      );
    });

  // add labels
  await mutate(
    `${GITHUB_API}/repos/${TARGET_REPO}/issues/${json.number}/labels`,
    `GitHub labels of PR #${json.number}`,
    { method: "POST", body: JSON.stringify({ labels }) },
  );

  // set assignee
  await mutate(
    `${GITHUB_API}/repos/${TARGET_REPO}/issues/${json.number}`,
    `GitHub assignee of PR #${json.number}`,
    {
      method: "PATCH",
      body: JSON.stringify({ assignees: [originalPr.user.login] }),
    },
  );

  // request review from original PR approvers
  const { approvers } = await getPrReviewers(originalPr);
  await mutate(
    `${GITHUB_API}/repos/${TARGET_REPO}/pulls/${json.number}/requested_reviewers`,
    `GitHub reviewers of PR #${json.number}`,
    { method: "POST", body: JSON.stringify({ reviewers: [...approvers] }) },
  );

  // if the original PR had exactly one backport/* label, add the backport/done label to it
  const backportLabels = originalPr.labels
    .filter((label) => label.name.startsWith("backport/"));
  if (backportLabels.length === 1) {
    await addLabels(originalPr.number, ["backport/done"]);
    console.log(`Added backport/done label to PR #${originalPr.number}`);
  }
};

export const addLabels = async (prNumber: number, labels: string[]) => {
  await mutate(
    `${GITHUB_API}/repos/${TARGET_REPO}/issues/${prNumber}/labels`,
    `GitHub add labels to #${prNumber}`,
    { method: "POST", body: JSON.stringify({ labels }) },
  );
};

export const addComment = async (issueNumber: number, comment: string) => {
  const added = await mutate(
    `${GITHUB_API}/repos/${TARGET_REPO}/issues/${issueNumber}/comments`,
    `GitHub comment on #${issueNumber}`,
    { method: "POST", body: JSON.stringify({ body: comment }) },
  );
  if (added) console.info(`Added comment to #${issueNumber}`);
};

// locks a given issue
export const lockIssue = async (
  issueNumber: number,
  reason: "off-topic" | "too heated" | "resolved" | "spam",
) => {
  const locked = await mutate(
    `${GITHUB_API}/repos/${TARGET_REPO}/issues/${issueNumber}/lock`,
    `GitHub lock issue #${issueNumber}`,
    { method: "PUT", body: JSON.stringify({ lock_reason: reason }) },
  );
  if (locked) console.info(`Locked issue #${issueNumber}`);
  return locked;
};

// returns issues that are unlocked, closed and have been closed before the given date. Only the first 30 results are returned.
export const fetchClosedOldIssuesAndPRs = (before: Date) => {
  // if we ever become a GitHub app, we need to separate the search query into
  // two queries, one for issues and one for PRs, and then merge the results
  return fetchSearchResults<{
    number: number;
    pull_request?: { url: string };
    updated_at: string;
  }>(
    `is:closed is:unlocked closed:<${before.toISOString()} repo:${TARGET_REPO}`,
  );
};

// returns the last comment of the given issue
export const fetchLastComment = async (issueNumber: number) => {
  const { json } = await fetchJSON(
    `${GITHUB_API}/repos/${TARGET_REPO}/issues/${issueNumber}/comments?per_page=1&sort=created&direction=desc`,
    `GitHub last comment of #${issueNumber}`,
  );
  if (!json.length) return null;
  return json[0];
};

// closes the given issue
export const closeIssue = (issueNumber: number) => {
  return mutate(
    `${GITHUB_API}/repos/${TARGET_REPO}/issues/${issueNumber}`,
    `GitHub close issue #${issueNumber}`,
    { method: "PATCH", body: JSON.stringify({ state: "closed" }) },
  );
};

// closes the given PR
export const closePr = (prNumber: number) => {
  return mutate(
    `${GITHUB_API}/repos/${TARGET_REPO}/pulls/${prNumber}`,
    `GitHub close PR #${prNumber}`,
    { method: "PATCH", body: JSON.stringify({ state: "closed" }) },
  );
};
