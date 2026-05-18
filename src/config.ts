export const TARGET_REPO = Deno.env.get("BACKPORTER_REPO") ??
  Deno.env.get("GITHUB_REPOSITORY") ??
  "go-gitea/gitea";

export const TARGET_REPO_HTTP = `https://github.com/${TARGET_REPO}`;
export const TARGET_REPO_GIT = `${TARGET_REPO_HTTP}.git`;

export const AVAILABLE_CHECKS = [
  "backport",
  "labels",
  "merge_queue",
  "lock",
  "feedback",
  "last_call",
  "milestones",
  "lgtm",
  "translation_comment",
  "pr_actions",
] as const;

export type CheckName = typeof AVAILABLE_CHECKS[number];

const AVAILABLE_CHECKS_SET = new Set<string>(AVAILABLE_CHECKS);

export const parseEnabledChecks = (
  checks: string | undefined,
): Set<CheckName> => {
  const normalizedChecks = checks?.trim().toLowerCase();
  if (!normalizedChecks || normalizedChecks === "all") {
    return new Set(AVAILABLE_CHECKS);
  }

  if (normalizedChecks === "none") {
    return new Set();
  }

  const selectedChecks = normalizedChecks
    .split(/[\s,]+/)
    .filter(Boolean);
  const invalidChecks = selectedChecks.filter((check) =>
    !AVAILABLE_CHECKS_SET.has(check)
  );

  if (invalidChecks.length > 0) {
    throw new Error(
      `Unknown BACKPORTER_CHECKS value(s): ${
        invalidChecks.join(", ")
      }. Supported values: all, none, ${AVAILABLE_CHECKS.join(", ")}`,
    );
  }

  return new Set(selectedChecks as CheckName[]);
};
