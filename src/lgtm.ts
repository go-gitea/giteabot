import {
  addLabels,
  fetchOpenPrsWithLabel,
  fetchPr,
  getPrReviewers,
  removeLabel,
  setCommitStatus,
} from "./github.ts";

export const lgtmLabels = {
  need2: "lgtm/need 2",
  need1: "lgtm/need 1",
  done: "lgtm/done",
  blocked: "lgtm/blocked",
};

// given a pr number, set its lgtm status check and lgtm label
export const setPrStatusAndLabel = async (
  pr: {
    labels: { name: string }[];
    head: { sha: string };
    title: string;
    number: number;
    requested_reviewers: { login: string }[];
  },
) => {
  let reviewers;
  try {
    reviewers = await getPrReviewers(pr);
  } catch (error) {
    console.error(error);
    return;
  }

  const { state, message, desiredLabel } = getPrStatusAndLabel(reviewers);
  const currentLgtmLabels = pr.labels.filter((l) => l.name.startsWith("lgtm/"));

  // remove any undesired lgtm labels
  await Promise.all(
    currentLgtmLabels.filter((l) => l.name !== desiredLabel).map(
      async (label) => {
        const response = await removeLabel(pr.number, label.name);
        if (response.ok) {
          console.info(
            `Removed ${label.name} from "${pr.title}" (#${pr.number})`,
          );
        } else {
          console.error(
            `Failed to remove ${label.name} from "${pr.title}" (#${pr.number})`,
          );
          console.error(await response.text());
        }
      },
    ),
  );

  // add desired label if it's not there
  if (!currentLgtmLabels.some((label) => label.name === desiredLabel)) {
    await addLabels(pr.number, [desiredLabel]);
  }

  // set commit status
  const response = await setCommitStatus(pr.head.sha, state, message);
  if (response.ok) {
    console.info(
      `Set commit status in "${pr.title}" (#${pr.number})`,
    );
  } else {
    console.error(
      `Failed to set commit status in  "${pr.title}" (#${pr.number})`,
    );
    console.error(await response.text());
  }
};

// returns the status, message, and label for a given number of approvals
export const getPrStatusAndLabel = (
  reviewers: { approvers: Set<string>; blockers: Set<string> },
) => {
  let desiredLabel = lgtmLabels.need2;
  let message = "Needs two more approvals";
  let state: "pending" | "success" | "failure" = "pending";

  if (reviewers.blockers.size > 0) {
    desiredLabel = lgtmLabels.blocked;
    message = "Blocked by " + Array.from(reviewers.blockers).join(", ");
    state = "failure";
    return { state, message, desiredLabel };
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

  return { state, message, desiredLabel };
};

// recompute the lgtm status/label for every open lgtm-labelled PR — or, with a
// `since` epoch-ms cutoff, only those updated since then (a review bumps
// updated_at, so a stale lgtm is always a recently-updated PR).
export const run = async (since?: number) => {
  // a failed label listing must not sink the whole sweep (it now runs on routine
  // pull_request_target events) — skip it; the next run / maintenance retries
  const prLists = await Promise.all(
    Object.values(lgtmLabels).map((label) =>
      fetchOpenPrsWithLabel(label).catch((error) => {
        console.error(`lgtm sweep: listing ${label} failed:`, error);
        return [];
      })
    ),
  );
  // a PR can surface under two tiers (the sweep advances it across tiers mid-run,
  // or GitHub's label index lags a recent change), so process each one once
  const seen = new Set<number>();
  for (const pr of prLists.flat()) {
    if (seen.has(pr.number)) continue;
    seen.add(pr.number);
    if (since !== undefined && new Date(pr.updated_at).getTime() < since) {
      continue;
    }
    try {
      await setPrStatusAndLabel(await fetchPr(pr.number));
    } catch (error) {
      console.error(`lgtm sweep failed for #${pr.number}:`, error);
    }
  }
};
