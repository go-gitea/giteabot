import { assertEquals } from "@std/testing/asserts";
import { assign } from "./milestones.ts";

Deno.test("assign() maps release/v1.27 to 1.27, release/v28 to the earliest 28.x and main to the highest milestone", async () => {
  const originalFetch = globalThis.fetch;
  const assigned: number[] = [];
  globalThis.fetch = ((_url: string, options?: RequestInit) => {
    if (options?.method === "PATCH") {
      assigned.push(JSON.parse(options.body as string).milestone);
      return Promise.resolve(Response.json({}));
    }
    return Promise.resolve(Response.json([
      { title: "1.27.4", number: 1 },
      { title: "28.1.0", number: 2 },
      { title: "28.0.0", number: 3 },
      { title: "29.0.0", number: 4 },
    ]));
  }) as typeof fetch;

  try {
    for (const ref of ["release/v1.27", "release/v28", "main"]) {
      await assign({ number: 1, base: { ref } });
    }
    assertEquals(assigned, [1, 3, 4]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
