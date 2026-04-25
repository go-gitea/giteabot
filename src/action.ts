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

const requiredEnv = ["BACKPORTER_GITEA_FORK", "BACKPORTER_GITHUB_TOKEN"];
const missingEnv = requiredEnv.filter((name) => !Deno.env.get(name));
if (missingEnv.length > 0) {
  console.error(`Missing required env vars: ${missingEnv.join(", ")}`);
  Deno.exit(1);
}

const eventName = Deno.env.get("GITHUB_EVENT_NAME");
const eventPath = Deno.env.get("GITHUB_EVENT_PATH");

if (!eventName || !eventPath) {
  console.error("GITHUB_EVENT_NAME and GITHUB_EVENT_PATH must be set");
  Deno.exit(1);
}

const payloadText = await Deno.readTextFile(eventPath);
const payload = JSON.parse(payloadText);

const runMaintenance = async () => {
  await labels.run();
  await mergeQueue.run();
  await lock.run();
  await feedback.run();
  await lastCall.run();
  await milestones.run();
};

const handlePullRequest = async (
  action: string,
  pr: typeof payload.pull_request,
) => {
  if (action === "labeled" || action === "unlabeled") {
    const labelName = payload.label?.name;
    if (labelName && labels.isRelevantLabel(labelName)) {
      await labels.run();
      await mergeQueue.run();
      await prActions.run(labelName, pr);
    }
    return;
  }

  if (action === "opened") {
    await labels.run();
    if (pr?.base?.ref === "main") {
      await comments.commentIfTranslationsChanged(pr);
    }
    if (pr?.base?.ref?.startsWith("release/")) {
      await milestones.assign(pr);
    }
  }

  if (
    action === "opened" ||
    action === "synchronize" ||
    action === "review_requested" ||
    action === "review_request_removed"
  ) {
    await lgtm.setPrStatusAndLabel(pr);
  }

  if (action === "closed") {
    if (pr?.merged && !pr?.milestone) {
      await milestones.assign(pr);
    }
    await milestones.run();
  }
};

switch (eventName) {
  case "push": {
    if (payload.ref === "refs/heads/main") {
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
    await lgtm.setPrStatusAndLabel(payload.pull_request);
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
