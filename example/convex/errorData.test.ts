import { Workpool } from "@convex-dev/workpool";
import workpool from "@convex-dev/workpool/test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { components, internal } from "./_generated/api.js";
import { initConvexTest } from "./setup.test.js";

const pool = new Workpool(components.bigPool, { logLevel: "ERROR" });
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

test.each(["query", "mutation", "action"] as const)(
  "preserves ConvexError data in the %s completion callback",
  async (functionType) => {
    const t = initConvexTest();
    workpool.register(t, "bigPool");
    const data = { code: "INVALID", count: 7 };
    const options = {
      onComplete: internal.errorData.onComplete,
      context: null,
    };
    await t.mutation(async (ctx) => {
      switch (functionType) {
        case "query":
          return await pool.enqueueQuery(
            ctx,
            internal.errorData.failingQuery,
            { data },
            options,
          );
        case "mutation":
          return await pool.enqueueMutation(
            ctx,
            internal.errorData.failingMutation,
            { data },
            options,
          );
        case "action":
          return await pool.enqueueAction(
            ctx,
            internal.errorData.failingAction,
            { data },
            {
              ...options,
              retry: { maxAttempts: 2, initialBackoffMs: 1, base: 1 },
            },
          );
      }
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const results = await t.query((ctx) => ctx.db.query("data").take(2));
    expect(results).toHaveLength(1);
    expect(results[0].misc).toMatchObject({ kind: "failed", errorData: data });
    expect(typeof results[0].misc.error).toBe("string");
  },
);
