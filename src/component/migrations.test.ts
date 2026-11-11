import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import batchWorker from "@convex-dev/batch-worker/test";
import { internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import schema from "./schema.js";
import { getCurrentSegment } from "./shared.js";

const modules = import.meta.glob("./**/*.ts");

describe("backfillPendingStartIds", () => {
  let t: ReturnType<typeof convexTest>;

  beforeEach(() => {
    vi.useFakeTimers();
    t = convexTest(schema, modules);
    batchWorker.register(t);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Insert work the way versions before the pointer did. */
  async function insertLegacy(count = 1) {
    return t.run(async (ctx) => {
      const inserted = [];
      for (let i = 0; i < count; i++) {
        const workId = await ctx.db.insert("work", {
          fnType: "action",
          fnHandle: "handle",
          fnName: "fn",
          fnArgs: {},
          attempts: 0,
        });
        const pendingId = await ctx.db.insert("pendingStart", {
          workId,
          segment: getCurrentSegment() + BigInt(i % 3) - 1n,
        });
        inserted.push({ workId, pendingId });
      }
      return inserted;
    });
  }

  async function pointerOf(workId: Id<"work">) {
    return t.run(
      async (ctx) => (await ctx.db.get("work", workId))?.pendingStartId ?? null,
    );
  }

  async function migrate(before?: number) {
    await t.mutation(internal.migrations.backfillPendingStartIds, { before });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  }

  it("records entries created before the run across pages", async () => {
    const legacy = await insertLegacy(600);
    // Under frozen time, convex-test spaces creation times 1µs apart.
    vi.advanceTimersByTime(1000);
    const before = Date.now();
    vi.advanceTimersByTime(1000);
    const [later] = await insertLegacy();

    await migrate(before);

    for (const { workId, pendingId } of legacy) {
      expect(await pointerOf(workId)).toBe(pendingId);
    }
    expect(await pointerOf(later.workId)).toBeNull();
  });

  it("keeps existing pointers and deletes entries whose work is gone", async () => {
    const [recorded, orphan] = await insertLegacy(2);
    // Visited first, but the work already points at its own entry.
    await t.run(async (ctx) => {
      await ctx.db.insert("pendingStart", {
        workId: recorded.workId,
        segment: getCurrentSegment(),
      });
      await ctx.db.patch("work", recorded.workId, {
        pendingStartId: recorded.pendingId,
      });
      await ctx.db.delete("work", orphan.workId);
    });

    await migrate();

    expect(await pointerOf(recorded.workId)).toBe(recorded.pendingId);
    expect(
      await t.run((ctx) => ctx.db.get("pendingStart", orphan.pendingId)),
    ).toBeNull();
  });
});
