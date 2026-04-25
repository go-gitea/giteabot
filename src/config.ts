export const TARGET_REPO =
  Deno.env.get("BACKPORTER_REPO") ??
  Deno.env.get("GITHUB_REPOSITORY") ??
  "go-gitea/gitea";

export const TARGET_REPO_HTTP = `https://github.com/${TARGET_REPO}`;
export const TARGET_REPO_GIT = `${TARGET_REPO_HTTP}.git`;
