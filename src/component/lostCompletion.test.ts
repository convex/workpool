/**
 * Work whose scheduled `complete` fails must not hold its slot forever (#276).
 * Faults are injected by swapping the `complete` export in the module map, so
 * everything else runs exactly as in production.
 */
import { createFunctionHandle, makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { v } from "convex/values";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import batchWorker from "@convex-dev/batch-worker/test";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import { internalMutation, mutation } from "./_generated/server.js";
import { MAX_COMPLETING } from "./loop.js";
import {
  findLegacyCompletion,
  MAX_COMPLETION_RERUNS,
  RECOVERY_READ_BUDGET,
  type Reads,
} from "./recovery.js";
import schema from "./schema.js";
import { modules } from "./setup.test.js";
import { MINUTE, SECOND, vResult } from "./shared.js";

const userRan = vi.fn<(name: string, attempt: number) => void>();
const onCompleteRan = vi.fn<(context: string, kind: string) => void>();
/** Remaining injected failures of `complete`, by work id. */
const completeFaults = new Map<string, number>();
/** Remaining injected failures of `complete` calls for canceled work. */
let canceledCompleteFaults = 0;
/** How many times the user function should throw before succeeding. */
let userFailures = 0;

function setup() {
  const t = convexTest(schema, {
    ...modules,
    "./complete.ts": async () => {
      const actual = await import("./complete.js");
      return {
        ...actual,
        complete: internalMutation({
          args: { jobs: v.array(v.any()) },
          handler: async (ctx, args) => {
            const jobs = args.jobs as {
              workId: string;
              runResult: { kind: string };
            }[];
            if (
              canceledCompleteFaults > 0 &&
              jobs.some((job) => job.runResult.kind === "canceled")
            ) {
              canceledCompleteFaults--;
              throw new Error("injected: complete(canceled) failed");
            }
            for (const job of jobs) {
              const remaining = completeFaults.get(job.workId) ?? 0;
              if (remaining > 0) {
                completeFaults.set(job.workId, remaining - 1);
                throw new Error("injected: complete failed");
              }
            }
            return actual.completeHandler(ctx, args as never);
          },
        }),
      };
    },
    "./userFns.ts": async () => ({
      work: mutation({
        args: { name: v.string() },
        handler: async (ctx, { name }) => {
          userRan(name, userRan.mock.calls.length);
          if (userFailures > 0) {
            userFailures--;
            throw new Error("user function failed");
          }
          return name;
        },
      }),
      onComplete: mutation({
        args: { workId: v.string(), context: v.any(), result: vResult },
        handler: async (_ctx, args) => {
          onCompleteRan(args.context, args.result.kind);
        },
      }),
    }),
  });
  batchWorker.register(t);
  return t;
}

type T = ReturnType<typeof setup>;
const MAX_PARALLELISM = 1;

async function handles(t: T) {
  return t.run(async () => ({
    work: await createFunctionHandle(
      makeFunctionReference<"mutation">("userFns:work"),
    ),
    onComplete: await createFunctionHandle(
      makeFunctionReference<"mutation">("userFns:onComplete"),
    ),
  }));
}

const config = { maxParallelism: MAX_PARALLELISM, logLevel: "ERROR" } as const;

async function enqueue(
  t: T,
  name: string,
  opts: { runAt?: number; maxAttempts?: number } = {},
) {
  const h = await handles(t);
  return t.mutation(api.lib.enqueue, {
    fnHandle: h.work,
    fnName: name,
    fnArgs: { name },
    fnType: "mutation",
    runAt: opts.runAt ?? Date.now(),
    config,
    onComplete: { fnHandle: h.onComplete, context: name },
    ...(opts.maxAttempts
      ? {
          retryBehavior: {
            maxAttempts: opts.maxAttempts,
            initialBackoffMs: 100,
            base: 2,
          },
        }
      : {}),
  });
}

async function internalState(t: T) {
  return t.run(async (ctx) => ctx.db.query("internalState").first());
}

/**
 * Advance simulated time, running whatever is due, and check after each step
 * that no more than maxParallelism entries hold a slot.
 */
async function drive(t: T, ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += 2 * SECOND) {
    vi.advanceTimersByTime(2 * SECOND);
    await t.finishInProgressScheduledFunctions();
    const state = await internalState(t);
    const holding = state?.running.filter((r) => !r.completing) ?? [];
    expect(holding.length).toBeLessThanOrEqual(MAX_PARALLELISM);
    const completing = state?.running.filter((r) => r.completing) ?? [];
    expect(completing.length).toBeLessThanOrEqual(MAX_COMPLETING);
  }
}

async function expectFinished(t: T, ...ids: Id<"work">[]) {
  for (const id of ids) {
    expect(await t.query(api.lib.status, { id })).toEqual({
      state: "finished",
    });
  }
  expect((await internalState(t))?.running).toEqual([]);
}

describe("lost completion", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    userRan.mockClear();
    onCompleteRan.mockClear();
    completeFaults.clear();
    canceledCompleteFaults = 0;
    userFailures = 0;
  });
  afterEach(() => vi.useRealTimers());

  it("re-runs a failed completion without re-running the mutation", async () => {
    const t = setup();
    const a = await enqueue(t, "A");
    completeFaults.set(a, 1);
    const b = await enqueue(t, "B");

    await drive(t, 15 * MINUTE);

    expect(userRan.mock.calls.map(([name]) => name)).toEqual(["A", "B"]);
    expect(onCompleteRan.mock.calls).toEqual([
      ["A", "success"],
      ["B", "success"],
    ]);
    await expectFinished(t, a, b);
  });

  it("keeps the retry policy when a failure's completion is lost", async () => {
    const t = setup();
    userFailures = 1;
    const a = await enqueue(t, "A", { maxAttempts: 3 });
    completeFaults.set(a, 1);

    await drive(t, 15 * MINUTE);

    // The failed attempt's writes rolled back, so retrying it is safe.
    expect(userRan).toHaveBeenCalledTimes(2);
    expect(onCompleteRan.mock.calls).toEqual([["A", "success"]]);
    await expectFinished(t, a);
  });

  it("gives up after repeated failures and frees the slot", async () => {
    const t = setup();
    const a = await enqueue(t, "A");
    completeFaults.set(a, Infinity);
    const b = await enqueue(t, "B");

    await drive(t, 20 * MINUTE);

    // A committed once and is never re-run; B is no longer blocked.
    expect(userRan.mock.calls.map(([name]) => name)).toEqual(["A", "B"]);
    expect(onCompleteRan.mock.calls).toEqual([["B", "success"]]);
    await expectFinished(t, b);
    const work = await t.run((ctx) => ctx.db.get("work", a));
    expect(work?.completionReruns).toBe(MAX_COMPLETION_RERUNS);
  });

  it("re-runs a failed completion for work canceled before it started", async () => {
    const t = setup();
    const a = await enqueue(t, "A", { runAt: Date.now() + 60 * MINUTE });
    completeFaults.set(a, 1);
    await t.mutation(api.lib.cancel, { id: a, logLevel: "ERROR" });
    const b = await enqueue(t, "B");

    // A's lost completion doesn't take B's slot.
    await drive(t, 10 * SECOND);
    expect(onCompleteRan.mock.calls).toEqual([["B", "success"]]);
    expect((await internalState(t))?.running).toMatchObject([
      { workId: a, completing: true },
    ]);

    await drive(t, 15 * MINUTE);
    expect(onCompleteRan.mock.calls).toEqual([
      ["B", "success"],
      ["A", "canceled"],
    ]);
    expect(userRan.mock.calls.map(([name]) => name)).toEqual(["B"]);
    await expectFinished(t, a, b);
  });

  it("bounds the running list when canceled work's completions fail", async () => {
    const t = setup();
    const h = await handles(t);
    const N = 600;
    for (let i = 0; i < N; i += 100) {
      await t.mutation(api.lib.enqueueBatch, {
        config,
        items: Array.from({ length: 100 }, (_, j) => ({
          fnHandle: h.work,
          fnName: `F${i + j}`,
          fnArgs: { name: `F${i + j}` },
          fnType: "mutation" as const,
          runAt: Date.now() + 60 * MINUTE,
          onComplete: { fnHandle: h.onComplete, context: `F${i + j}` },
        })),
      });
    }
    // Enough failed batches to reach the limit before recovery runs.
    canceledCompleteFaults = Math.ceil(MAX_COMPLETING / 64) + 2;
    await t.mutation(api.lib.cancelAll, {
      logLevel: "ERROR",
      limit: N,
      before: Number.MAX_SAFE_INTEGER,
    });
    const b = await enqueue(t, "B");

    // Cancelations wait while the running list is full of completing work,
    // and B isn't blocked by them.
    await drive(t, 10 * SECOND);
    expect(onCompleteRan.mock.calls).toEqual([["B", "success"]]);
    const state = await internalState(t);
    expect(state?.running.length).toBe(MAX_COMPLETING);
    // Completing work isn't reported as running or as using capacity.
    expect(await t.query(internal.stats.diagnostics, {})).toMatchObject({
      running: 0,
      spareCapacity: MAX_PARALLELISM,
    });
    expect(await t.query(internal.stats.running, {})).toEqual([]);

    await drive(t, 30 * MINUTE);
    const canceled = onCompleteRan.mock.calls.filter(
      ([, kind]) => kind === "canceled",
    );
    expect(canceled).toHaveLength(N);
    expect(userRan.mock.calls.map(([name]) => name)).toEqual(["B"]);
    await expectFinished(t, b);
  });

  it("recovers a mutation whose completion was lost before completionId existed", async () => {
    const t = setup();
    const a = await enqueue(t, "A");
    completeFaults.set(a, 1);
    const b = await enqueue(t, "B");

    // A's wrapper succeeds and its `complete` fails. Clearing completionId
    // leaves A as an older `runMutationWrapper` left it.
    await drive(t, 10 * SECOND);
    await t.run(async (ctx) => {
      const work = await ctx.db.get("work", a);
      expect(work?.completionId).toBeDefined();
      await ctx.db.patch("work", a, { completionId: undefined });
    });
    expect(onCompleteRan).not.toHaveBeenCalled();

    await drive(t, 15 * MINUTE);

    expect(userRan.mock.calls.map(([name]) => name)).toEqual(["A", "B"]);
    expect(onCompleteRan.mock.calls).toEqual([
      ["A", "success"],
      ["B", "success"],
    ]);
    await expectFinished(t, a, b);
  });

  it("passes jobs to another recover call past the read budget", async () => {
    const t = setup();
    const big = "x".repeat(Math.ceil(RECOVERY_READ_BUDGET / 3));
    const ids = await t.run(async (ctx) => {
      const out = [];
      for (let i = 0; i < 4; i++) {
        const workId = await ctx.db.insert("work", {
          fnType: "mutation",
          fnHandle: "handle",
          fnName: `W${i}`,
          fnArgs: {},
          attempts: 0,
        });
        completeFaults.set(workId, 1);
        const completionId = await ctx.scheduler.runAfter(
          0,
          internal.complete.complete,
          {
            jobs: [
              {
                workId,
                runResult: { kind: "success", returnValue: big },
                attempt: 0,
              },
            ],
          },
        );
        await ctx.db.patch("work", workId, { completionId });
        out.push({ workId, completionId });
      }
      return out;
    });
    // Each injected fault fails its `complete` once.
    vi.advanceTimersByTime(SECOND);
    await t.finishInProgressScheduledFunctions();

    await t.mutation(internal.recovery.recover, {
      jobs: ids.map(({ workId, completionId }) => ({
        workId,
        scheduledId: completionId,
        attempt: 0,
        started: Date.now() - 10 * MINUTE,
      })),
    });

    const after = await t.run(async (ctx) => ({
      works: await Promise.all(
        ids.map(({ workId }) => ctx.db.get("work", workId)),
      ),
      recovers: (await ctx.db.system.query("_scheduled_functions").collect())
        .filter((f) => f.name.includes("recover") && f.state.kind === "pending")
        .map((f) => (f.args[0] as { jobs: { workId: string }[] }).jobs),
    }));
    // The first three fill the budget and are re-run here; the fourth waits
    // for the next recover call.
    expect(after.works.map((w) => w?.completionReruns)).toEqual([
      1,
      1,
      1,
      undefined,
    ]);
    expect(after.recovers).toEqual([
      [expect.objectContaining({ workId: ids[3]!.workId })],
    ]);
  });

  it("finds a legacy completion behind many older scheduled functions", async () => {
    const t = setup();
    const found = await t.run(async (ctx) => {
      const scheduledTime = Date.now();
      // Unrelated records created earlier in the window than the `complete`.
      for (let i = 0; i < 600; i++) {
        await ctx.scheduler.runAfter(MINUTE, internal.loop.updateRunStatus, {});
      }
      const workId = await ctx.db.insert("work", {
        fnType: "mutation",
        fnHandle: "handle",
        fnName: "A",
        fnArgs: {},
        attempts: 0,
      });
      const completionId = await ctx.scheduler.runAfter(
        MINUTE,
        internal.complete.complete,
        {
          jobs: [
            {
              workId,
              runResult: { kind: "success", returnValue: null },
              attempt: 0,
            },
          ],
        },
      );
      const reads: Reads = { bytes: 0, docs: new Map() };
      // Stands in for the wrapper's record, which the real scheduler marks
      // with completedTime as the wrapper commits.
      const wrapper = {
        scheduledTime,
        completedTime: Date.now(),
      } as Parameters<typeof findLegacyCompletion>[2];
      const result = await findLegacyCompletion(ctx, reads, wrapper, {
        workId,
        attempt: 0,
      });
      return { result, completionId };
    });
    expect(found.result).toBe(found.completionId);
  });

  it("stops a legacy search at the read budget", async () => {
    const t = setup();
    const { result, bytes } = await t.run(async (ctx) => {
      const scheduledTime = Date.now();
      const big = "x".repeat(Math.ceil(RECOVERY_READ_BUDGET / 4));
      const workId = await ctx.db.insert("work", {
        fnType: "mutation",
        fnHandle: "handle",
        fnName: "A",
        fnArgs: {},
        attempts: 0,
      });
      // Large records with no matching `complete` among them.
      for (let i = 0; i < 10; i++) {
        await ctx.scheduler.runAfter(MINUTE, internal.complete.complete, {
          jobs: [
            {
              workId,
              runResult: { kind: "success", returnValue: big },
              attempt: 1,
            },
          ],
        });
      }
      const reads: Reads = { bytes: 0, docs: new Map() };
      const wrapper = {
        scheduledTime,
        completedTime: Date.now(),
      } as Parameters<typeof findLegacyCompletion>[2];
      const result = await findLegacyCompletion(ctx, reads, wrapper, {
        workId,
        attempt: 0,
      });
      return { result, bytes: reads.bytes };
    });
    expect(result).toBe("overBudget");
    // It read up to the budget, not all ten records.
    expect(bytes).toBeLessThan(RECOVERY_READ_BUDGET * 1.5);
  });

  it("waits on a completion that's still pending in the scheduler", async () => {
    const t = setup();
    const job = await t.run(async (ctx) => {
      const workId = await ctx.db.insert("work", {
        fnType: "mutation",
        fnHandle: "handle",
        fnName: "A",
        fnArgs: {},
        attempts: 0,
      });
      // Stands in for a scheduler backlog: due, but not yet run.
      const completionId = await ctx.scheduler.runAfter(
        MINUTE,
        internal.complete.complete,
        {
          jobs: [
            {
              workId,
              runResult: { kind: "success", returnValue: null },
              attempt: 0,
            },
          ],
        },
      );
      await ctx.db.patch("work", workId, { completionId });
      // The wrapper itself succeeded long ago.
      const scheduledId = await ctx.scheduler.runAfter(
        0,
        internal.loop.updateRunStatus,
        {},
      );
      return {
        workId,
        scheduledId,
        completionId,
        attempt: 0,
        started: Date.now() - 10 * MINUTE,
      };
    });

    await t.mutation(internal.recovery.recover, {
      jobs: [
        {
          workId: job.workId,
          scheduledId: job.scheduledId,
          attempt: job.attempt,
          started: job.started,
        },
      ],
    });

    const after = await t.run(async (ctx) => ({
      work: await ctx.db.get("work", job.workId),
      completions: (
        await ctx.db.system.query("_scheduled_functions").collect()
      ).filter((f) => f.name.includes("complete")),
    }));
    expect(after.work?.completionId).toBe(job.completionId);
    expect(after.work?.completionReruns).toBeUndefined();
    expect(after.completions).toHaveLength(1);
  });
});
