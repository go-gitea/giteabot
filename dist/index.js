import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { setTimeout } from "node:timers/promises";

//#region src/cmd.ts
const runCommand = (command, options = {}) => new Promise((resolve, reject) => {
	execFile(command, options.args ?? [], {
		cwd: options.cwd,
		maxBuffer: 67108864
	}, (error, stdout, stderr) => {
		if (typeof error?.code === "string") {
			reject(new Error(error.message));
			return;
		}
		resolve({
			success: !error,
			stdout,
			stderr
		});
	});
});

//#endregion
//#region src/config.ts
const TARGET_REPO = process.env.BACKPORTER_REPO ?? process.env.GITHUB_REPOSITORY ?? "go-gitea/gitea";
const TARGET_REPO_HTTP = `https://github.com/${TARGET_REPO}`;
const TARGET_REPO_GIT = `${TARGET_REPO_HTTP}.git`;
const AVAILABLE_CHECKS = [
	"backport",
	"labels",
	"merge_queue",
	"lock",
	"feedback",
	"last_call",
	"milestones",
	"lgtm",
	"translation_comment",
	"pr_actions"
];
const AVAILABLE_CHECKS_SET = new Set(AVAILABLE_CHECKS);
function parseEnabledChecks(checks) {
	const normalizedChecks = checks?.trim().toLowerCase();
	if (!normalizedChecks || normalizedChecks === "all") return new Set(AVAILABLE_CHECKS);
	if (normalizedChecks === "none") return /* @__PURE__ */ new Set();
	const selectedChecks = normalizedChecks.split(/[\s,]+/).filter(Boolean);
	const invalidChecks = selectedChecks.filter((check) => !AVAILABLE_CHECKS_SET.has(check));
	if (invalidChecks.length > 0) throw new Error(`Unknown checks value(s): ${invalidChecks.join(", ")}. Supported values: all, none, ${AVAILABLE_CHECKS.join(", ")}`);
	return new Set(selectedChecks);
}

//#endregion
//#region src/git.ts
const getPrBranchName = (prNumber, giteaMajorMinorVersion) => `backport-${prNumber}-v${giteaMajorMinorVersion}`;
let repoDir = "";
async function git(args) {
	const result = await runCommand("git", {
		args,
		cwd: repoDir
	});
	if (!result.success) throw new Error(`git ${args[0]} failed:\n${result.stderr}`);
}
async function initializeGitRepo(user, email) {
	repoDir = await mkdtemp(join(tmpdir(), "giteabot-"));
	await git([
		"clone",
		`https://${process.env.INPUT_GITHUB_TOKEN}@github.com/${process.env.INPUT_GITEA_FORK}.git`,
		"."
	]);
	await git([
		"remote",
		"add",
		"upstream",
		TARGET_REPO_GIT
	]);
	await git([
		"config",
		"user.name",
		user
	]);
	await git([
		"config",
		"user.email",
		email ?? "teabot@gitea.io"
	]);
}
async function cherryPickPr(commitHash, prNumber, giteaMajorMinorVersion) {
	await git([
		"fetch",
		"upstream",
		"main"
	]);
	await git([
		"fetch",
		"upstream",
		`release/v${giteaMajorMinorVersion}`
	]);
	const branch = getPrBranchName(prNumber, giteaMajorMinorVersion);
	await git([
		"checkout",
		`upstream/release/v${giteaMajorMinorVersion}`,
		"-b",
		branch
	]);
	const { success, stdout, stderr } = await runCommand("git", {
		cwd: repoDir,
		args: ["cherry-pick", commitHash]
	});
	if (!success) {
		console.error(`Cherry-pick failed:\n${stdout}\n${stderr}`.trim());
		await runCommand("git", {
			cwd: repoDir,
			args: ["cherry-pick", "--abort"]
		});
		return false;
	}
	await git([
		"push",
		"origin",
		branch
	]);
	return true;
}

//#endregion
//#region src/state.ts
const backportPrExistsCache = /* @__PURE__ */ new Set();

//#endregion
//#region src/version.ts
function parseVersion(title) {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(title);
	if (!match) return null;
	const [major, minor, patch] = match.slice(1).map(Number);
	return {
		major,
		minor,
		patch
	};
}
const compareVersions = (a, b) => a.major - b.major || a.minor - b.minor || a.patch - b.patch;
const releaseVersion = ({ major, minor }) => major > 1 ? String(major) : `${major}.${minor}`;

//#endregion
//#region src/github.ts
const GITHUB_API = "https://api.github.com";
const HEADERS = {
	"Content-Type": "application/json",
	Authorization: `Bearer ${process.env.INPUT_GITHUB_TOKEN}`
};
async function readText(response) {
	try {
		return await response.text();
	} catch {
		return "";
	}
}
const MAX_RETRY_DELAY_MS = 6e4;
const capOrFail = (ms) => ms > MAX_RETRY_DELAY_MS ? null : ms;
function getRetryDelay(response, message) {
	const retryAfterHeader = response.headers.get("retry-after");
	const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : NaN;
	if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) return capOrFail(retryAfterSeconds * 1e3);
	const rateLimitRemaining = Number(response.headers.get("x-ratelimit-remaining"));
	const rateLimitReset = Number(response.headers.get("x-ratelimit-reset"));
	if (rateLimitRemaining === 0 && Number.isFinite(rateLimitReset) && rateLimitReset > 0) return capOrFail(Math.max(rateLimitReset * 1e3 - Date.now(), 1e3));
	if (response.status === 429 || response.status === 403 && message.includes("rate limit")) return 1e3;
	if (response.status >= 500) return 1e3;
	return null;
}
const FETCH_MAX_ATTEMPTS = 5;
async function fetchWithRetry(url, label, options) {
	for (let attempt = 1;; attempt++) {
		let response;
		try {
			response = await fetch(url, {
				headers: HEADERS,
				...options
			});
		} catch (error) {
			if (attempt >= FETCH_MAX_ATTEMPTS) throw error;
			console.warn(`${label} failed on attempt ${attempt}. Retrying in 1000ms.`);
			await setTimeout(1e3);
			continue;
		}
		if (response.ok) return response;
		const message = response.status === 403 ? (await readText(response.clone())).toLowerCase() : "";
		const retryDelay = getRetryDelay(response, message);
		if (attempt >= FETCH_MAX_ATTEMPTS || retryDelay === null) return response;
		console.warn(`${label} failed on attempt ${attempt}. Retrying in ${retryDelay}ms.`);
		await setTimeout(retryDelay);
	}
}
async function parseJSON(response, label) {
	const text = await readText(response);
	if (!response.ok) throw new Error(`${label} failed: ${response.status} ${text.slice(0, 300)}`);
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch {
		throw new Error(`${label} returned invalid JSON: ${text.slice(0, 300)}`);
	}
}
async function fetchJSON(url, label, options) {
	const response = await fetchWithRetry(url, label, options);
	return {
		response,
		json: await parseJSON(response, label)
	};
}
async function mutate(url, label, options) {
	const response = await fetchWithRetry(url, label, options);
	if (!response.ok) {
		const text = await readText(response);
		console.error(`${label} failed: ${response.status} ${text.slice(0, 300)}`);
	}
	return response.ok;
}
async function fetchSearchResults(query) {
	const { json } = await fetchJSON(`${GITHUB_API}/search/issues?q=${encodeURIComponent(query)}`, `GitHub search ${JSON.stringify(query)}`);
	return json;
}
async function fetchList(path) {
	const all = [];
	let url = `${GITHUB_API}${path}`;
	while (url) {
		const { response, json } = await fetchJSON(url, `GitHub list ${url}`);
		all.push(...json);
		url = /<([^>]+)>[^,]*?\brel="next"/.exec(response.headers.get("link") ?? "")?.[1] ?? null;
	}
	return all;
}
async function fetchCurrentUser() {
	const { json } = await fetchJSON(`${GITHUB_API}/user`, "GitHub current user");
	return json;
}
function fetchCandidates(giteaMajorMinorVersion) {
	return fetchSearchResults(`is:pr is:merged base:main label:backport/v${giteaMajorMinorVersion} -label:backport/done -label:backport/manual repo:${TARGET_REPO}`);
}
const fetchIssuesByLabel = (state, label, suffix = "") => fetchList(`/repos/${TARGET_REPO}/issues?per_page=100&state=${state}&labels=${encodeURIComponent(label)}${suffix}`);
const fetchMergedWithLabel = async (label) => (await fetchIssuesByLabel("closed", label)).filter((item) => item.pull_request?.merged_at);
const fetchOpenIssuesWithLabel = async (label) => (await fetchIssuesByLabel("open", label)).filter((item) => !item.pull_request);
const fetchOpenPrsWithLabel = async (label) => (await fetchIssuesByLabel("open", label)).filter((item) => item.pull_request);
const fetchPendingMerge = async () => (await fetchIssuesByLabel("open", "reviewed/wait-merge", "&sort=created&direction=asc")).filter((item) => item.pull_request);
function fetchOpenPrs() {
	return fetchList(`/repos/${TARGET_REPO}/pulls?per_page=100&state=open`);
}
function fetchTargeting(branch) {
	return fetchList(`/repos/${TARGET_REPO}/pulls?per_page=100&state=open&base=${encodeURIComponent(branch)}`);
}
function fetchUnmergedClosedWithMilestone(milestoneTitle) {
	return fetchSearchResults(`is:pr is:closed is:unmerged milestone:${milestoneTitle} repo:${TARGET_REPO}`);
}
function fetchBreakingWithoutLabel() {
	return fetchSearchResults(`is:pr "## :warning: BREAKING" -label:pr/breaking repo:${TARGET_REPO}`);
}
async function fetchPrFileNames(prNumber) {
	const files = await fetchList(`/repos/${TARGET_REPO}/pulls/${prNumber}/files?per_page=100`);
	return new Set(files.map((file) => file.filename));
}
async function updatePr(prNumber) {
	const pr = await fetchPr(prNumber);
	return fetchWithRetry(`${GITHUB_API}/repos/${TARGET_REPO}/pulls/${prNumber}/update-branch`, `GitHub update branch of PR #${prNumber}`, {
		method: "PUT",
		body: JSON.stringify({ expected_head_sha: pr.head.sha })
	});
}
function setCommitStatus(sha, state, description) {
	return mutate(`${GITHUB_API}/repos/${TARGET_REPO}/statuses/${sha}`, `GitHub commit status of ${sha}`, {
		method: "POST",
		body: JSON.stringify({
			state,
			context: "giteabot/lgtm",
			description
		})
	});
}
async function fetchBranch(branch) {
	const { json } = await fetchJSON(`${GITHUB_API}/repos/${TARGET_REPO}/branches/${branch}`, `GitHub branch ${branch}`);
	return json;
}
async function branchExists(branch) {
	const response = await fetchWithRetry(`${GITHUB_API}/repos/${TARGET_REPO}/branches/${branch}`, `GitHub branch ${branch}`, { method: "HEAD" });
	if (response.status === 404) return false;
	if (!response.ok) throw new Error(`branchExists(${branch}) failed: ${response.status} ${response.statusText}`);
	return true;
}
async function needsUpdate(prNumber) {
	const pr = await fetchPr(prNumber);
	if (!pr.maintainer_can_modify) return false;
	if (pr.state !== "open") return false;
	const base = await fetchBranch(pr.base.ref);
	return pr.base.sha !== base.commit.sha;
}
async function removeLabel(prNumber, label) {
	const removed = await mutate(`${GITHUB_API}/repos/${TARGET_REPO}/issues/${prNumber}/labels/${label}`, `GitHub remove label ${label} from #${prNumber}`, { method: "DELETE" });
	if (removed) console.info(`Removed ${label} from #${prNumber}`);
	return removed;
}
async function fetchPr(prNumber) {
	const { json } = await fetchJSON(`${GITHUB_API}/repos/${TARGET_REPO}/pulls/${prNumber}`, `GitHub PR #${prNumber}`);
	return json;
}
function setMilestone(prNumber, milestone) {
	return mutate(`${GITHUB_API}/repos/${TARGET_REPO}/issues/${prNumber}`, `GitHub milestone of PR #${prNumber}`, {
		method: "PATCH",
		body: JSON.stringify({ milestone })
	});
}
async function backportPrExists(pr, giteaMajorMinorVersion) {
	const cacheKey = `${pr.number}_${giteaMajorMinorVersion}`;
	if (backportPrExistsCache.has(cacheKey)) return true;
	if ((await fetchSearchResults(`is:pr is:open repo:${TARGET_REPO} base:release/v${giteaMajorMinorVersion} ${pr.number} in:title`)).total_count > 0) {
		backportPrExistsCache.add(cacheKey);
		return true;
	}
	const branchName = getPrBranchName(pr.number, giteaMajorMinorVersion);
	if ((await fetchWithRetry(`${GITHUB_API}/repos/${process.env.INPUT_GITEA_FORK}/branches/${branchName}`, `GitHub backport branch ${branchName}`, { method: "HEAD" })).ok) {
		backportPrExistsCache.add(cacheKey);
		return true;
	}
	return false;
}
async function getMilestones() {
	const earliestPatchVersions = {};
	for (const milestone of await fetchList(`/repos/${TARGET_REPO}/milestones?per_page=100`)) {
		const version = parseVersion(milestone.title);
		if (!version) continue;
		const key = releaseVersion(version);
		if (!earliestPatchVersions[key] || compareVersions(version, earliestPatchVersions[key].version) < 0) earliestPatchVersions[key] = {
			...milestone,
			version
		};
	}
	return Object.values(earliestPatchVersions);
}
async function getPrReviewers(pr) {
	const reviews = await fetchList(`/repos/${TARGET_REPO}/pulls/${pr.number}/reviews?per_page=100`);
	const approvers = /* @__PURE__ */ new Set();
	const blockers = /* @__PURE__ */ new Set();
	for (const review of reviews) switch (review.state) {
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
	}
	for (const requestedReviewer of pr.requested_reviewers) approvers.delete(requestedReviewer.login);
	return {
		approvers,
		blockers
	};
}
async function createBackportPr(originalPr, giteaVersion) {
	let prDescription = `Backport #${originalPr.number} by @${originalPr.user.login}`;
	if (originalPr.body) prDescription += `\n\n${originalPr.body}`;
	const { json } = await fetchJSON(`${GITHUB_API}/repos/${TARGET_REPO}/pulls`, `GitHub create backport PR of #${originalPr.number}`, {
		method: "POST",
		body: JSON.stringify({
			title: `${originalPr.title} (#${originalPr.number})`,
			head: `${process.env.INPUT_GITEA_FORK.split("/")[0]}:${getPrBranchName(originalPr.number, giteaVersion.majorMinorVersion)}`,
			base: `release/v${giteaVersion.majorMinorVersion}`,
			body: prDescription,
			maintainer_can_modify: true
		})
	});
	const excludedPrefixes = [
		"lgtm/",
		"backport/",
		"reviewed/",
		"size/",
		"pr/"
	];
	await addLabels(json.number, originalPr.labels.map((label) => label.name).filter((label) => excludedPrefixes.every((prefix) => !label.startsWith(prefix))));
	await mutate(`${GITHUB_API}/repos/${TARGET_REPO}/issues/${json.number}`, `GitHub assignee of PR #${json.number}`, {
		method: "PATCH",
		body: JSON.stringify({ assignees: [originalPr.user.login] })
	});
	const { approvers } = await getPrReviewers(originalPr);
	await mutate(`${GITHUB_API}/repos/${TARGET_REPO}/pulls/${json.number}/requested_reviewers`, `GitHub reviewers of PR #${json.number}`, {
		method: "POST",
		body: JSON.stringify({ reviewers: [...approvers] })
	});
	if (originalPr.labels.filter((label) => label.name.startsWith("backport/")).length === 1) {
		await addLabels(originalPr.number, ["backport/done"]);
		console.info(`Added backport/done label to PR #${originalPr.number}`);
	}
}
async function addLabels(prNumber, labels) {
	await mutate(`${GITHUB_API}/repos/${TARGET_REPO}/issues/${prNumber}/labels`, `GitHub add labels to #${prNumber}`, {
		method: "POST",
		body: JSON.stringify({ labels })
	});
}
async function addComment(issueNumber, comment) {
	if (await mutate(`${GITHUB_API}/repos/${TARGET_REPO}/issues/${issueNumber}/comments`, `GitHub comment on #${issueNumber}`, {
		method: "POST",
		body: JSON.stringify({ body: comment })
	})) console.info(`Added comment to #${issueNumber}`);
}
async function lockIssue(issueNumber, reason) {
	const locked = await mutate(`${GITHUB_API}/repos/${TARGET_REPO}/issues/${issueNumber}/lock`, `GitHub lock issue #${issueNumber}`, {
		method: "PUT",
		body: JSON.stringify({ lock_reason: reason })
	});
	if (locked) console.info(`Locked issue #${issueNumber}`);
	return locked;
}
function fetchClosedOldIssuesAndPRs(before) {
	return fetchSearchResults(`is:closed is:unlocked closed:<${before.toISOString()} repo:${TARGET_REPO}`);
}
async function hasCommentsSince(issueNumber, since) {
	return (await fetchList(`/repos/${TARGET_REPO}/issues/${issueNumber}/comments?per_page=100&since=${since.toISOString()}`)).some((comment) => new Date(comment.created_at) > since);
}
function closeIssue(issueNumber) {
	return mutate(`${GITHUB_API}/repos/${TARGET_REPO}/issues/${issueNumber}`, `GitHub close issue #${issueNumber}`, {
		method: "PATCH",
		body: JSON.stringify({ state: "closed" })
	});
}
function closePr(prNumber) {
	return mutate(`${GITHUB_API}/repos/${TARGET_REPO}/pulls/${prNumber}`, `GitHub close PR #${prNumber}`, {
		method: "PATCH",
		body: JSON.stringify({ state: "closed" })
	});
}

//#endregion
//#region src/giteaVersion.ts
var GiteaVersion = class {
	majorMinorVersion;
	version;
	milestoneNumber;
	constructor(milestone) {
		this.version = milestone.version;
		this.majorMinorVersion = releaseVersion(milestone.version);
		this.milestoneNumber = milestone.number;
	}
};
async function fetchGiteaVersions() {
	return (await getMilestones()).map((milestone) => new GiteaVersion(milestone));
}

//#endregion
//#region src/backport.ts
async function createBackports() {
	const user = await fetchCurrentUser();
	await initializeGitRepo(user.login, user.email);
	const versions = await fetchGiteaVersions();
	const hasBranch = await Promise.all(versions.map((v) => branchExists(`release/v${v.majorMinorVersion}`)));
	for (const [index, giteaVersion] of versions.entries()) {
		if (!hasBranch[index]) continue;
		const candidates = await fetchCandidates(giteaVersion.majorMinorVersion);
		for (const candidate of candidates.items) {
			console.info(`Parsing #${candidate.number}`);
			await parseCandidate(candidate, giteaVersion);
		}
	}
}
async function parseCandidate(candidate, giteaVersion) {
	if (await backportPrExists(candidate, giteaVersion.majorMinorVersion)) {
		console.info(`Backport PR already exists for #${candidate.number}`);
		return;
	}
	const originalPr = await fetchPr(candidate.number);
	console.info(`Cherry-picking #${originalPr.number}`);
	if (!await cherryPickPr(originalPr.merge_commit_sha, originalPr.number, giteaVersion.majorMinorVersion)) {
		const branch = getPrBranchName(originalPr.number, giteaVersion.majorMinorVersion);
		await addComment(originalPr.number, `I was unable to create a backport for ${giteaVersion.majorMinorVersion}. @${originalPr.user.login}, please send one manually. :tea:

\`\`\`sh
git fetch origin release/v${giteaVersion.majorMinorVersion}
git switch -c ${branch} FETCH_HEAD
git cherry-pick ${originalPr.merge_commit_sha}
# fix conflicts, then git cherry-pick --continue
\`\`\`
`);
		await addLabels(originalPr.number, ["backport/manual"]);
		return;
	}
	console.info(`Creating backport PR for #${originalPr.number}`);
	await createBackportPr(originalPr, giteaVersion);
}

//#endregion
//#region src/labels.ts
function isRelevantLabel(label) {
	return label.startsWith("reviewed/") || label.startsWith("backport/") || label.startsWith("giteabot/");
}
async function maintainLabels() {
	await Promise.all([
		removeLabelsFromMergedPr([
			"reviewed/wait-merge",
			"reviewed/prioritize-merge",
			"pr/last-call"
		]),
		removeBackportLabelsFromPrsTargetingReleaseBranches(),
		addKindBreakingToBreakingPrs()
	]);
}
async function addKindBreakingToBreakingPrs() {
	const breakingPrs = await fetchBreakingWithoutLabel();
	return Promise.all(breakingPrs.items.map((pr) => addLabels(pr.number, ["pr/breaking"])));
}
function removeLabelsFromMergedPr(labels) {
	return Promise.all(labels.map(async (label) => {
		const prs = await fetchMergedWithLabel(label);
		return Promise.all(prs.map((pr) => removeLabel(pr.number, label)));
	}));
}
async function removeBackportLabelsFromPrsTargetingReleaseBranches() {
	const giteaVersions = await fetchGiteaVersions();
	await Promise.all(giteaVersions.map(async (version) => {
		const prs = await fetchTargeting(`release/v${version.majorMinorVersion}`);
		await Promise.all(prs.flatMap((pr) => pr.labels.filter((label) => label.name.startsWith("backport/")).map((label) => removeLabel(pr.number, label.name))));
	}));
}

//#endregion
//#region src/prActions.ts
async function executePrAction(label, pr) {
	if (label === "giteabot/update-branch") {
		const err = await updateBranch(pr);
		if (err) {
			await addComment(pr.number, `I failed to update the branch because of the following error: ${err.message} Sorry about that. :tea:`);
			return;
		}
		await removeLabel(pr.number, "giteabot/update-branch");
	}
}
async function updateBranch(pr) {
	if (await needsUpdate(pr.number)) {
		const response = await updatePr(pr.number);
		if (response.ok) {
			console.info(`Synced PR #${pr.number}`);
			return;
		}
		const text = await readText(response);
		let body = null;
		try {
			body = JSON.parse(text);
		} catch {}
		if (body?.message !== "merge conflict between base and head") {
			console.error(`Failed to sync PR #${pr.number}`);
			console.error(text);
			return new Error(body?.message ?? `HTTP ${response.status}`);
		}
		console.info(`Merge conflict detected in PR #${pr.number}`);
		await addComment(pr.number, `@${pr.user.login} please fix the merge conflicts. :tea:`);
		return /* @__PURE__ */ new Error("merge conflicts in PR");
	}
}

//#endregion
//#region src/mergeQueue.ts
async function updateMergeQueue() {
	for (const pr of await fetchPendingMerge()) if ((await updateBranch(pr))?.message === "merge conflicts in PR") await removeLabel(pr.number, "reviewed/wait-merge");
}

//#endregion
//#region src/milestones.ts
async function assignMilestone(pr) {
	const giteaVersions = await fetchGiteaVersions();
	const giteaVersion = pr.base.ref === "main" ? giteaVersions.toSorted((a, b) => compareVersions(b.version, a.version))[0] : giteaVersions.find((version) => pr.base.ref === `release/v${version.majorMinorVersion}`);
	if (!giteaVersion) {
		console.info(`No milestone matches ${pr.base.ref} for PR #${pr.number}`);
		return;
	}
	if (await setMilestone(pr.number, giteaVersion.milestoneNumber)) console.info(`Set milestone ${giteaVersion.majorMinorVersion} for PR #${pr.number}`);
}
async function removeMilestonesFromUnmergedClosedPrs() {
	const milestones = await getMilestones();
	return Promise.all(milestones.map(async (m) => {
		const prs = await fetchUnmergedClosedWithMilestone(m.title);
		return Promise.all(prs.items.map(async (pr) => {
			if (await setMilestone(pr.number, null)) console.info(`Removed milestone from closed PR #${pr.number}`);
		}));
	}));
}

//#endregion
//#region src/lgtm.ts
const lgtmLabels = {
	need2: "lgtm/need 2",
	need1: "lgtm/need 1",
	done: "lgtm/done",
	blocked: "lgtm/blocked"
};
async function setPrStatusAndLabel(pr) {
	let reviewers;
	try {
		reviewers = await getPrReviewers(pr);
	} catch (error) {
		console.error(error);
		return;
	}
	const { state, message, desiredLabel } = getPrStatusAndLabel(reviewers);
	const currentLgtmLabels = pr.labels.filter((l) => l.name.startsWith("lgtm/"));
	await Promise.all(currentLgtmLabels.filter((l) => l.name !== desiredLabel).map((label) => removeLabel(pr.number, label.name)));
	if (currentLgtmLabels.every((label) => label.name !== desiredLabel)) await addLabels(pr.number, [desiredLabel]);
	if (await setCommitStatus(pr.head.sha, state, message)) console.info(`Set commit status in "${pr.title}" (#${pr.number})`);
}
async function setPrStatusAndLabelBySha(sha) {
	for (const pr of await fetchOpenPrs()) if (pr.head.sha === sha) await setPrStatusAndLabel(await fetchPr(pr.number));
}
function getPrStatusAndLabel(reviewers) {
	let desiredLabel = lgtmLabels.need2;
	let message = "Needs two more approvals";
	let state = "pending";
	if (reviewers.blockers.size > 0) {
		desiredLabel = lgtmLabels.blocked;
		message = `Blocked by ${Array.from(reviewers.blockers).join(", ")}`;
		state = "failure";
		return {
			state,
			message,
			desiredLabel
		};
	}
	if (reviewers.approvers.size === 1) {
		desiredLabel = lgtmLabels.need1;
		message = "Needs one more approval";
	}
	if (reviewers.approvers.size >= 2) {
		desiredLabel = lgtmLabels.done;
		message = `Approved by ${reviewers.approvers.size} people`;
		state = "success";
	}
	return {
		state,
		message,
		desiredLabel
	};
}
async function sweepLgtmPrs(since) {
	const prLists = await Promise.all(Object.values(lgtmLabels).map(async (label) => {
		try {
			return await fetchOpenPrsWithLabel(label);
		} catch (error) {
			console.error(`lgtm sweep: listing ${label} failed:`, error);
			return [];
		}
	}));
	const seen = /* @__PURE__ */ new Set();
	for (const pr of prLists.flat()) {
		if (seen.has(pr.number)) continue;
		seen.add(pr.number);
		if (since !== void 0 && new Date(pr.updated_at).getTime() < since) continue;
		try {
			await setPrStatusAndLabel(await fetchPr(pr.number));
		} catch (error) {
			console.error(`lgtm sweep failed for #${pr.number}:`, error);
		}
	}
}

//#endregion
//#region src/comments.ts
async function commentIfTranslationsChanged(pr) {
	if ((await fetchPrFileNames(pr.number)).values().some((fileName) => fileName.startsWith("options/locale/") && (fileName.endsWith(".ini") || fileName.endsWith(".json")) && !fileName.endsWith("en-US.ini") && !fileName.endsWith("en-US.json"))) {
		const comment = `@${pr.user.login} I noticed you've updated the locales for non-English languages. These will be overwritten during the sync from our translation tool Crowdin. If you'd like to contribute your translations, please visit https://crowdin.com/project/gitea. Please revert the changes done on these files. :tea:`;
		await addComment(pr.number, comment);
	}
}

//#endregion
//#region src/lock.ts
const MILLISECONDS_IN_A_DAY = 864e5;
async function lockOldIssues() {
	const twoWeeksAgo = /* @__PURE__ */ new Date(Date.now() - MILLISECONDS_IN_A_DAY * 14);
	const threeMonthsAgo = /* @__PURE__ */ new Date(Date.now() - MILLISECONDS_IN_A_DAY * 90);
	const issues = await fetchClosedOldIssuesAndPRs(threeMonthsAgo);
	return Promise.all(issues.items.map(async (issue) => {
		if (await lockIssue(issue.number, "resolved") && await hasCommentsSince(issue.number, twoWeeksAgo)) await addComment(issue.number, `We lock ${issue.pull_request ? "pull request" : "issue"}s 3 months after they were closed. If there's any need for further discussion, please open a new issue. :tea:`);
	}));
}

//#endregion
//#region src/feedback.ts
async function closeStaleFeedbackIssues() {
	const issues = await fetchOpenIssuesWithLabel("issue/needs-feedback");
	return Promise.all(issues.map(handleIssue));
}
async function handleIssue(issue) {
	const oneMonthAgo = (/* @__PURE__ */ new Date(Date.now() - 2592e6)).getTime();
	if (new Date(issue.updated_at).getTime() < oneMonthAgo) {
		console.info(`Closing issue #${issue.number} due to feedback timeout`);
		await addComment(issue.number, `We close issues that need feedback from the author if there were no new comments for a month. :tea:`);
		await closeIssue(issue.number);
	}
}

//#endregion
//#region src/lastCall.ts
async function handleLastCallPrs() {
	const prs = await fetchOpenPrsWithLabel("pr/last-call");
	return Promise.all(prs.map(handlePr));
}
async function handlePr(pr) {
	const lastPrUpdateTime = new Date(pr.updated_at).getTime();
	if (lastPrUpdateTime < (/* @__PURE__ */ new Date(Date.now() - 6048e5)).getTime() && pr.labels.some((l) => l.name === lgtmLabels.need1) && pr.labels.every((l) => l.name !== "giteabot/toc-reminded")) {
		console.info(`Reminding PR #${pr.number} due to pr/last-call timeout`);
		await addComment(pr.number, "This pull request has a last call and has not had any activity in the past week. @go-gitea/technical-oversight-committee please review this pull request and either merge it or request a review from a maintainer. :tea:");
		await addLabels(pr.number, ["giteabot/toc-reminded"]);
		return;
	}
	if (lastPrUpdateTime < (/* @__PURE__ */ new Date(Date.now() - 12096e5)).getTime()) {
		console.info(`Closing PR #${pr.number} due to pr/last-call timeout`);
		await addComment(pr.number, `This pull request has a last call and has not had any activity in the past two weeks. Consider it to be a [polite refusal](${TARGET_REPO_HTTP}/blob/main/CONTRIBUTING.md#final-call). :tea:`);
		await closePr(pr.number);
	}
}

//#endregion
//#region src/action.ts
let enabledChecks;
try {
	enabledChecks = parseEnabledChecks(process.env.INPUT_CHECKS);
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	process.exit(1);
}
const missingInputs = ["github_token", ...enabledChecks.has("backport") ? ["gitea_fork"] : []].filter((name) => !process.env[`INPUT_${name.toUpperCase()}`]);
if (missingInputs.length > 0) {
	console.error(`Missing required inputs: ${missingInputs.join(", ")}`);
	process.exit(1);
}
async function runCheck(checkName, callback) {
	if (!enabledChecks.has(checkName)) {
		console.info(`Skipping ${checkName} check`);
		return;
	}
	try {
		await callback();
	} catch (error) {
		console.error(`${checkName} check failed:`, error);
		process.exitCode = 1;
	}
}
const eventName = process.env.GITHUB_EVENT_NAME;
const eventPath = process.env.GITHUB_EVENT_PATH;
if (!eventName || !eventPath) {
	console.error("GITHUB_EVENT_NAME and GITHUB_EVENT_PATH must be set");
	process.exit(1);
}
const payloadText = await readFile(eventPath, "utf8");
const payload = JSON.parse(payloadText);
async function runMaintenance() {
	await runCheck("labels", maintainLabels);
	await runCheck("merge_queue", updateMergeQueue);
	await runCheck("lock", lockOldIssues);
	await runCheck("feedback", closeStaleFeedbackIssues);
	await runCheck("last_call", handleLastCallPrs);
	await runCheck("milestones", removeMilestonesFromUnmergedClosedPrs);
	await runCheck("lgtm", sweepLgtmPrs);
}
async function handlePullRequest(action, pr) {
	if (action === "labeled" || action === "unlabeled") {
		const labelName = payload.label?.name;
		if (labelName && isRelevantLabel(labelName)) {
			await runCheck("labels", maintainLabels);
			await runCheck("merge_queue", updateMergeQueue);
			await runCheck("pr_actions", () => executePrAction(labelName, pr));
		}
		return;
	}
	if (action === "opened") {
		await runCheck("labels", maintainLabels);
		if (pr.base.ref === "main") await runCheck("translation_comment", () => commentIfTranslationsChanged(pr));
		if (pr.base.ref.startsWith("release/")) await runCheck("milestones", () => assignMilestone(pr));
	}
	if (action === "opened" || action === "synchronize" || action === "review_requested" || action === "review_request_removed") await runCheck("lgtm", () => setPrStatusAndLabel(pr));
	else if (action === "closed") {
		if (pr.merged && !pr.milestone) await runCheck("milestones", () => assignMilestone(pr));
		await runCheck("milestones", removeMilestonesFromUnmergedClosedPrs);
	}
}
switch (eventName) {
	case "push":
		if (payload.ref === "refs/heads/main") await runCheck("backport", createBackports);
		await runMaintenance();
		break;
	case "pull_request":
	case "pull_request_target": {
		await handlePullRequest(payload.action, payload.pull_request);
		const isLabelEvent = payload.action === "labeled" || payload.action === "unlabeled";
		if (eventName === "pull_request_target" && !isLabelEvent) await runCheck("lgtm", () => sweepLgtmPrs(Date.now() - 36e5));
		break;
	}
	case "pull_request_review":
		await runCheck("lgtm", () => setPrStatusAndLabel(payload.pull_request));
		break;
	case "workflow_run":
		await runCheck("lgtm", () => setPrStatusAndLabelBySha(payload.workflow_run.head_sha));
		break;
	case "schedule":
	case "workflow_dispatch":
		await runMaintenance();
		break;
	default: console.info(`No handlers for ${eventName}`);
}

//#endregion
export {  };