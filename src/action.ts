import * as backport from "./backport.ts";
import * as labels from "./labels.ts";
import * as mergeQueue from "./mergeQueue.ts";
import * as milestones from "./milestones.ts";
import * as lgtm from "./lgtm.ts";
import * as comments from "./comments.ts";
import * as lock from "./lock.ts";
import * as prActions from "./prActions.ts";
import * as feedback from "./feedback.ts";
import * as lastCall from "./lastCall.ts";
import { type CheckName, parseEnabledChecks } from "./config.ts";

let enabledChecks: Set<CheckName>;
try {
  enabledChecks = parseEnabledChecks(Deno.env.get("BACKPORTER_CHECKS"));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  Deno.exit(1);
}

const requiredEnv = [
  "BACKPORTER_GITHUB_TOKEN",
  ...(enabledChecks.has("backport") ? ["BACKPORTER_GITEA_FORK"] : []),
];
const missingEnv = requiredEnv.filter((name) => !Deno.env.get(name));
if (missingEnv.length > 0) {
  console.error(`Missing required env vars: ${missingEnv.join(", ")}`);
  Deno.exit(1);
}

const shouldRunCheck = (checkName: CheckName) => enabledChecks.has(checkName);

const runCheck = async (
  checkName: CheckName,
  callback: () => unknown,
) => {
  if (!shouldRunCheck(checkName)) {
    console.info(`Skipping ${checkName} check`);
    return;
  }
  await callback();
};

const eventName = Deno.env.get("GITHUB_EVENT_NAME");
const eventPath = Deno.env.get("GITHUB_EVENT_PATH");

if (!eventName || !eventPath) {
  console.error("GITHUB_EVENT_NAME and GITHUB_EVENT_PATH must be set");
  Deno.exit(1);
}

const payloadText = await Deno.readTextFile(eventPath);
const payload = JSON.parse(payloadText);

const runMaintenance = async () => {
  await runCheck("labels", () => labels.run());
  await runCheck("merge_queue", () => mergeQueue.run());
  await runCheck("lock", () => lock.run());
  await runCheck("feedback", () => feedback.run());
  await runCheck("last_call", () => lastCall.run());
  await runCheck("milestones", () => milestones.run());
};

const handlePullRequest = async (
  action: string,
  pr: typeof payload.pull_request,
) => {
  if (action === "labeled" || action === "unlabeled") {
    const labelName = payload.label?.name;
    if (labelName && labels.isRelevantLabel(labelName)) {
      await runCheck("labels", () => labels.run());
      await runCheck("merge_queue", () => mergeQueue.run());
      await runCheck("pr_actions", () => prActions.run(labelName, pr));
    }
    return;
  }

  if (action === "opened") {
    await runCheck("labels", () => labels.run());
    if (pr?.base?.ref === "main") {
      await runCheck(
        "translation_comment",
        () => comments.commentIfTranslationsChanged(pr),
      );
    }
    if (pr?.base?.ref?.startsWith("release/")) {
      await runCheck("milestones", () => milestones.assign(pr));
    }
  }

  if (
    action === "opened" ||
    action === "synchronize" ||
    action === "review_requested" ||
    action === "review_request_removed"
  ) {
    await runCheck("lgtm", () => lgtm.setPrStatusAndLabel(pr));
  }

  if (action === "closed") {
    if (pr?.merged && !pr?.milestone && shouldRunCheck("milestones")) {
      await milestones.assign(pr);
    }
    await runCheck("milestones", () => milestones.run());
  }
};

switch (eventName) {
  case "push": {
    if (payload.ref === "refs/heads/main" && shouldRunCheck("backport")) {
      await backport.run();
    }
    await runMaintenance();
    break;
  }
  case "pull_request":
  case "pull_request_target": {
    await handlePullRequest(payload.action, payload.pull_request);
    break;
  }
  case "pull_request_review": {
    await runCheck(
      "lgtm",
      () => lgtm.setPrStatusAndLabel(payload.pull_request),
    );
    break;
  }
  case "schedule":
  case "workflow_dispatch": {
    await runMaintenance();
    break;
  }
  default:
    console.log(`No handlers for ${eventName}`);
}
