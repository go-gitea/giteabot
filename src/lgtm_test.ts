import { assertEquals } from "@std/testing/asserts";
import { run } from "./lgtm.ts";

Deno.test("run() recomputes a PR once when it surfaces under two label queries", async () => {
  const originalFetch = globalThis.fetch;
  const json = (data: unknown) =>
    Promise.resolve(
      new Response(JSON.stringify(data), {
        headers: { "Content-Type": "application/json" },
      }),
    );
  let prFetches = 0;
  let statusWrites = 0;
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = input.toString();
    if (url.includes("/pulls/1/reviews")) return json([]);
    if (url.includes("/pulls/1")) {
      prFetches++;
      return json({
        number: 1,
        title: "t",
        head: { sha: "abc" },
        labels: [{ name: "lgtm/need 2" }],
        requested_reviewers: [],
      });
    }
    if (url.includes("/issues?")) {
      // PR #1 is returned by both the "lgtm/need 2" and "lgtm/done" queries
      const hit = url.includes("need%202") || url.includes("lgtm%2Fdone");
      return json(hit ? [{ number: 1, pull_request: {} }] : []);
    }
    if (url.includes("/statuses/")) {
      statusWrites++;
      return json({});
    }
    return json({});
  }) as typeof fetch;

  try {
    await run();
    assertEquals(prFetches, 1); // deduped across the two label queries
    assertEquals(statusWrites, 1); // status recomputed and written once
  } finally {
    globalThis.fetch = originalFetch;
  }
});
