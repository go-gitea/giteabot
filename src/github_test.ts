import assert from "node:assert/strict";
import { test } from "node:test";
import {
  backportPrExists,
  fetchBranch,
  fetchCandidates,
  fetchLastComment,
  fetchPr,
  fetchPrFileNames,
  getPrReviewers,
} from "./github.ts";

test("fetchCandidates() retries GitHub search failures", async () => {
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = (() => {
    attempts++;
    if (attempts < 2) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            message: "You have exceeded a secondary rate limit.",
          }),
          {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              "Retry-After": "0.001",
            },
          },
        ),
      );
    }
    return Promise.resolve(
      new Response(
        JSON.stringify({
          total_count: 1,
          incomplete_results: false,
          items: [{ number: 123 }],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
  }) as typeof fetch;

  try {
    const result = await fetchCandidates("1.26");
    assert.deepEqual(attempts, 2);
    assert.deepEqual(result.items.length, 1);
    assert.deepEqual(result.items[0].number, 123);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchCandidates() throws the GitHub API error payload", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    return Promise.resolve(
      new Response(
        JSON.stringify({
          message: "Bad credentials",
        }),
        {
          status: 401,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
  }) as typeof fetch;

  try {
    await assert.rejects(
      () => fetchCandidates("1.26"),
      /Bad credentials/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getPrReviewers() returns the appropriate approvers", async () => {
  const prToApproversAndBlockers = {
    8346: { // note lafriks and guillep2k are requested reviewers so they don't count as approvers nor blockers
      approvers: new Set([
        "silverwind",
        "6543",
        "lunny",
        "techknowlogick",
        "zeripath",
        "sapk",
        "BaxAndrei",
      ]),
      blockers: new Set(["SuperSandro2000"]),
    },
    23993: {
      approvers: new Set(["delvh", "jolheiser"]),
      blockers: new Set<string>(),
    },
    24051: {
      approvers: new Set(["delvh", "silverwind"]),
      blockers: new Set<string>(),
    },
    24047: {
      approvers: new Set(["yardenshoham", "lunny"]),
      blockers: new Set<string>(),
    },
    24055: { approvers: new Set<string>(), blockers: new Set<string>() },
    24147: { // delvh approved and then self-requested review
      approvers: new Set<string>(),
      blockers: new Set<string>(),
    },
    24254: {
      approvers: new Set(["jolheiser", "yardenshoham"]),
      blockers: new Set<string>(),
    },
    24259: {
      approvers: new Set(["jolheiser", "delvh"]),
      blockers: new Set<string>(),
    },
    24270: {
      approvers: new Set(["lunny", "delvh", "silverwind"]),
      blockers: new Set<string>(),
    },
  };
  await Promise.all(
    Object.entries(prToApproversAndBlockers).map(
      async ([prNumber, approversAndBlockers]) => {
        const pr = await fetchPr(Number(prNumber));
        const result = await getPrReviewers(pr);
        assert.deepEqual(result.approvers, approversAndBlockers.approvers);
        assert.deepEqual(result.blockers, approversAndBlockers.blockers);
      },
    ),
  );
});

test('fetchBranch("main") returns the appropriate main branch', async () => {
  const mainBranch = await fetchBranch("main");
  assert.deepEqual(mainBranch.name, "main");
  assert.deepEqual(mainBranch.protected, true);
  assert.deepEqual(
    mainBranch._links.html,
    "https://github.com/go-gitea/gitea/tree/main",
  );
});

test("fetchBranch() handles full ref name well", async () => {
  const [mainBranch, releaseV119Branch] = await Promise.all([
    fetchBranch("refs/heads/main"),
    fetchBranch("refs/heads/release/v1.19"),
  ]);
  assert.deepEqual(mainBranch.name, "main");
  assert.deepEqual(mainBranch.protected, true);
  assert.deepEqual(
    mainBranch._links.html,
    "https://github.com/go-gitea/gitea/tree/main",
  );
  assert.deepEqual(releaseV119Branch.name, "release/v1.19");
  assert.deepEqual(releaseV119Branch.protected, true);
  assert.deepEqual(
    releaseV119Branch._links.html,
    "https://github.com/go-gitea/gitea/tree/release/v1.19",
  );
});

test("fetchPrFileNames() returns the appropriate files", async () => {
  const prToFiles = {
    25432: new Set([
      "modules/setting/database.go",
      "options/locale/locale_en-US.ini",
      "routers/install/install.go",
      "services/forms/user_form.go",
      "templates/install.tmpl",
    ]),
    24825: new Set(["models/repo/topic.go"]),
  };

  await Promise.all(
    Object.entries(prToFiles).map(
      async ([prNumber, files]) => {
        const result = await fetchPrFileNames(Number(prNumber));
        assert.deepEqual(result, files);
      },
    ),
  );
});

test("fetchPrFileNames() can handle big PRs", async () => {
  const aPrWith669Files = await fetchPrFileNames(24147);
  assert.deepEqual(aPrWith669Files.size, 669);
});

test("fetchLastComment() returns the appropriate comment", async () => {
  const prToLastComment = {
    10: "Closing as fixed by #199 ",
    29: null,
    1000: "LGTM",
    10000:
      "It is a feature of SQL databases. The repo id is stored in the database and uses auto increment:\r\nhttps://www.w3schools.com/sql/sql_autoincrement.asp",
  };
  await Promise.all(
    Object.entries(prToLastComment).map(
      async ([issueNumber, comment]) => {
        const result = await fetchLastComment(Number(issueNumber));
        if (!comment) return assert.ok(!result);
        assert.deepEqual(result.body, comment);
      },
    ),
  );
});

test("backportPrExists() returns the appropriate result", async () => {
  const prAndVersionToBackportExists = {
    "30511_1.22": true,
    "30511_1.21": true,
    "30511_1.20": false,
  };
  await Promise.all(
    Object.entries(prAndVersionToBackportExists).map(
      async ([prAndVersion, backportExists]) => {
        const [prNumber, version] = prAndVersion.split("_");
        const result = await backportPrExists(
          { number: Number(prNumber) },
          version,
        );
        assert.deepEqual(result, backportExists);
      },
    ),
  );
});
