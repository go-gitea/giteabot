import { assertEquals, assertThrows } from "@std/testing/asserts";
import { AVAILABLE_CHECKS, parseEnabledChecks } from "./config.ts";

Deno.test("parseEnabledChecks() enables all checks by default", () => {
  assertEquals(parseEnabledChecks(undefined), new Set(AVAILABLE_CHECKS));
  assertEquals(parseEnabledChecks("all"), new Set(AVAILABLE_CHECKS));
});

Deno.test("parseEnabledChecks() accepts comma and whitespace separated checks", () => {
  assertEquals(
    parseEnabledChecks("labels, merge_queue\nlock"),
    new Set(["labels", "merge_queue", "lock"]),
  );
});

Deno.test("parseEnabledChecks() accepts none", () => {
  assertEquals(parseEnabledChecks("none"), new Set());
});

Deno.test("parseEnabledChecks() rejects unsupported checks", () => {
  assertThrows(
    () => parseEnabledChecks("labels,unknown"),
    Error,
    "Unknown BACKPORTER_CHECKS value(s): unknown",
  );
});
