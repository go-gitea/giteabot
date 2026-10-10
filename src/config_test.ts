import assert from "node:assert/strict";
import { test } from "node:test";
import { AVAILABLE_CHECKS, parseEnabledChecks } from "./config.ts";

test("parseEnabledChecks() enables all checks by default", () => {
  assert.deepEqual(parseEnabledChecks(undefined), new Set(AVAILABLE_CHECKS));
  assert.deepEqual(parseEnabledChecks("all"), new Set(AVAILABLE_CHECKS));
});

test("parseEnabledChecks() accepts comma and whitespace separated checks", () => {
  assert.deepEqual(
    parseEnabledChecks("labels, merge_queue\nlock"),
    new Set(["labels", "merge_queue", "lock"]),
  );
});

test("parseEnabledChecks() accepts none", () => {
  assert.deepEqual(parseEnabledChecks("none"), new Set());
});

test("parseEnabledChecks() rejects unsupported checks", () => {
  assert.throws(
    () => parseEnabledChecks("labels,unknown"),
    /Unknown BACKPORTER_CHECKS value\(s\): unknown/,
  );
});
