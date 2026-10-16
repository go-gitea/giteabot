import {readFile} from 'node:fs/promises';
import {createBackports} from './backport.ts';
import {isRelevantLabel, maintainLabels} from './labels.ts';
import {updateMergeQueue} from './mergeQueue.ts';
import {assignMilestone, removeMilestonesFromUnmergedClosedPrs} from './milestones.ts';
import {setPrStatusAndLabel, setPrStatusAndLabelBySha, sweepLgtmPrs} from './lgtm.ts';
import {commentIfTranslationsChanged} from './comments.ts';
import {lockOldIssues} from './lock.ts';
import {executePrAction} from './prActions.ts';
import {closeStaleFeedbackIssues} from './feedback.ts';
import {handleLastCallPrs} from './lastCall.ts';
import {type CheckName, parseEnabledChecks} from './config.ts';

let enabledChecks: Set<CheckName>;
try {
  enabledChecks = parseEnabledChecks(process.env.BACKPORTER_CHECKS);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

const requiredEnv = ['BACKPORTER_GITHUB_TOKEN', ...(enabledChecks.has('backport') ? ['BACKPORTER_GITEA_FORK'] : [])];
const missingEnv = requiredEnv.filter((name) => !process.env[name]);
if (missingEnv.length > 0) {
  console.error(`Missing required env vars: ${missingEnv.join(', ')}`);
  process.exit(1);
}

const shouldRunCheck = (checkName: CheckName) => enabledChecks.has(checkName);

async function runCheck(checkName: CheckName, callback: () => unknown) {
  if (!shouldRunCheck(checkName)) {
    console.info(`Skipping ${checkName} check`);
    return;
  }
  await callback();
}

const eventName = process.env.GITHUB_EVENT_NAME;
const eventPath = process.env.GITHUB_EVENT_PATH;

if (!eventName || !eventPath) {
  console.error('GITHUB_EVENT_NAME and GITHUB_EVENT_PATH must be set');
  process.exit(1);
}

const payloadText = await readFile(eventPath, 'utf8');
const payload = JSON.parse(payloadText);

async function runMaintenance() {
  await runCheck('labels', () => maintainLabels());
  await runCheck('merge_queue', () => updateMergeQueue());
  await runCheck('lock', () => lockOldIssues());
  await runCheck('feedback', () => closeStaleFeedbackIssues());
  await runCheck('last_call', () => handleLastCallPrs());
  await runCheck('milestones', () => removeMilestonesFromUnmergedClosedPrs());
  await runCheck('lgtm', () => sweepLgtmPrs());
}

async function handlePullRequest(action: string, pr: typeof payload.pull_request) {
  if (action === 'labeled' || action === 'unlabeled') {
    const labelName = payload.label?.name;
    if (labelName && isRelevantLabel(labelName)) {
      await runCheck('labels', () => maintainLabels());
      await runCheck('merge_queue', () => updateMergeQueue());
      await runCheck('pr_actions', () => executePrAction(labelName, pr));
    }
    return;
  }

  if (action === 'opened') {
    await runCheck('labels', () => maintainLabels());
    if (pr?.base?.ref === 'main') {
      await runCheck('translation_comment', () => commentIfTranslationsChanged(pr));
    }
    if (pr?.base?.ref?.startsWith('release/')) {
      await runCheck('milestones', () => assignMilestone(pr));
    }
  }

  if (
    action === 'opened' ||
    action === 'synchronize' ||
    action === 'review_requested' ||
    action === 'review_request_removed'
  ) {
    await runCheck('lgtm', () => setPrStatusAndLabel(pr));
  } else if (action === 'closed') {
    if (pr?.merged && !pr?.milestone && shouldRunCheck('milestones')) {
      await assignMilestone(pr);
    }
    await runCheck('milestones', () => removeMilestonesFromUnmergedClosedPrs());
  }
}

switch (eventName) {
  case 'push': {
    if (payload.ref === 'refs/heads/main' && shouldRunCheck('backport')) {
      await createBackports();
    }
    await runMaintenance();
    break;
  }
  case 'pull_request':
  case 'pull_request_target': {
    await handlePullRequest(payload.action, payload.pull_request);
    // reviews the workflow_run relay misses, e.g. on conflicting PRs without a
    // merge ref, get reconciled on these frequent trusted events: recompute PRs
    // touched in the last hour (the daily maintenance sweep is the backstop). Skip
    // labeled/unlabeled: the bot's own lgtm label writes fire those and would
    // re-trigger the reconcile.
    const isLabelEvent = payload.action === 'labeled' || payload.action === 'unlabeled';
    if (eventName === 'pull_request_target' && !isLabelEvent) {
      await runCheck('lgtm', () => sweepLgtmPrs(Date.now() - 1000 * 60 * 60));
    }
    break;
  }
  case 'pull_request_review': {
    await runCheck('lgtm', () => setPrStatusAndLabel(payload.pull_request));
    break;
  }
  // pull_request_review gets a read-only token on fork PRs, so a review workflow triggers this writable run
  case 'workflow_run': {
    await runCheck('lgtm', () => setPrStatusAndLabelBySha(payload.workflow_run.head_sha));
    break;
  }
  case 'schedule':
  case 'workflow_dispatch': {
    await runMaintenance();
    break;
  }
  default:
    console.info(`No handlers for ${eventName}`);
}
