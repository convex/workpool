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
  async function insertLegacy(segment: bigint) {
    return t.run(async (ctx) => {
      const workId = await ctx.db.insert("work", {
        fnType: "action",
        fnHandle: "handle",
        fnName: "fn",
        fnArgs: {},
        attempts: 0,
      });
      const pendingId = await ctx.db.insert("pendingStart", {
        workId,
        segment,
      });
      return { workId, pendingId };
    });
  }

  async function pointerOf(workId: Id<"work">) {
    return t.run(
      async (ctx) => (await ctx.db.get("work", workId))?.pendingStartId ?? null,
    );
  }

  async function migrate() {
    await t.mutation(internal.migrations.backfillPendingStartIds, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
  }

  it("records future starts across pages and leaves due starts to the loop", async () => {
    const now = getCurrentSegment();
    const future = [];
    for (let i = 1n; i <= 150n; i++) {
      future.push(await insertLegacy(now + i));
    }
    const due = await insertLegacy(now);

    await migrate();

    for (const { workId, pendingId } of future) {
      expect(await pointerOf(workId)).toBe(pendingId);
    }
    expect(await pointerOf(due.workId)).toBeNull();
  });

  it("keeps existing pointers and skips entries whose work is gone", async () => {
    const now = getCurrentSegment();
    const recorded = await insertLegacy(now + 10n);
    // Visited first, but the work already points at its own entry.
    await t.run((ctx) =>
      ctx.db.insert("pendingStart", {
        workId: recorded.workId,
        segment: now + 20n,
      }),
    );
    await t.run((ctx) =>
      ctx.db.patch("work", recorded.workId, {
        pendingStartId: recorded.pendingId,
      }),
    );
    const orphan = await insertLegacy(now + 30n);
    await t.run((ctx) => ctx.db.delete("work", orphan.workId));

    await migrate();

    expect(await pointerOf(recorded.workId)).toBe(recorded.pendingId);
  });
});
