/**
 * Work whose scheduled `complete` fails must not hold its slot forever (#276),
 * and canceled work's completions must stay within maxParallelism. Faults are
 * injected by swapping the `complete` export in the module map, so everything
 * else runs exactly as in production.
 */
import { createFunctionHandle, makeFunctionReference } from "convex/server";
import { convexTest } from "convex-test";
import { v } from "convex/values";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import batchWorker from "@convex-dev/batch-worker/test";
import { api, internal } from "./_generated/api.js";
import type { Id } from "./_generated/dataModel.js";
import {
  internalMutation,
  mutation,
  type MutationCtx,
} from "./_generated/server.js";
import {
  findLegacyCompletion,
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
/** The most running entries seen at the end of any main loop iteration. */
let mostRunning = 0;
/** The most jobs waiting in scheduled `complete` calls at the same point. */
let mostCompleting = 0;

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
    // Check the running list after every main loop iteration, not just
    // between test steps.
    "./loop.ts": async () => {
      const actual = await import("./loop.js");
      const run = (
        actual.run as unknown as {
          _handler: (ctx: MutationCtx, args: unknown) => Promise<null>;
        }
      )._handler;
      return {
        ...actual,
        run: internalMutation({
          handler: async (ctx, args: Record<string, unknown>) => {
            const result = await run(ctx, args);
            const state = await ctx.db.query("internalState").unique();
            mostRunning = Math.max(mostRunning, state?.running.length ?? 0);
            // Jobs whose scheduled `complete` hasn't committed yet: their
            // work is still on the attempt the completion is for.
            let completing = 0;
            for await (const f of ctx.db.system.query("_scheduled_functions")) {
              const waiting =
                f.state.kind === "pending" || f.state.kind === "inProgress";
              if (!waiting || !f.name.endsWith("complete")) continue;
              const { jobs } = f.args[0] as {
                jobs: { workId: Id<"work">; attempt: number }[];
              };
              for (const job of jobs) {
                const work = await ctx.db.get("work", job.workId);
                if (work?.attempts === job.attempt) completing++;
              }
            }
            mostCompleting = Math.max(mostCompleting, completing);
            return result;
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
 * Advance simulated time, running whatever is due, and check that no main
 * loop iteration left more than maxParallelism jobs running or completing.
 */
async function drive(t: T, ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += 2 * SECOND) {
    vi.advanceTimersByTime(2 * SECOND);
    await t.finishInProgressScheduledFunctions();
    expect(mostRunning).toBeLessThanOrEqual(MAX_PARALLELISM);
    expect(mostCompleting).toBeLessThanOrEqual(MAX_PARALLELISM);
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

async function deadLetters(t: T) {
  return t.query(internal.deadLetter.list, {});
}

describe("lost completion", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    userRan.mockClear();
    onCompleteRan.mockClear();
    completeFaults.clear();
    canceledCompleteFaults = 0;
    userFailures = 0;
    mostRunning = 0;
    mostCompleting = 0;
  });
  afterEach(() => vi.useRealTimers());

  it("dead-letters a failed completion without re-running the mutation", async () => {
    const t = setup();
    const a = await enqueue(t, "A");
    completeFaults.set(a, 1);
    const b = await enqueue(t, "B");

    await drive(t, 10 * MINUTE);

    // A committed once and isn't retried; B is no longer blocked.
    expect(userRan.mock.calls.map(([name]) => name)).toEqual(["A", "B"]);
    expect(onCompleteRan.mock.calls).toEqual([["B", "success"]]);
    await expectFinished(t, b);
    const [letter, ...rest] = await deadLetters(t);
    expect(rest).toEqual([]);
    expect(letter).toMatchObject({
      workId: a,
      fnName: "A",
      attempt: 0,
      error: expect.any(String),
      resultAvailable: true,
    });

    // Retrying it by hand runs its onComplete with the stored result.
    await t.mutation(internal.deadLetter.retry, { id: letter!.id });
    await drive(t, 10 * SECOND);
    expect(onCompleteRan.mock.calls).toEqual([
      ["B", "success"],
      ["A", "success"],
    ]);
    expect(userRan.mock.calls.map(([name]) => name)).toEqual(["A", "B"]);
    await expectFinished(t, a, b);
    expect(await deadLetters(t)).toEqual([]);
  });

  it("keeps the retry policy when a dead letter is retried", async () => {
    const t = setup();
    userFailures = 1;
    const a = await enqueue(t, "A", { maxAttempts: 3 });
    completeFaults.set(a, 1);

    await drive(t, 10 * MINUTE);
    expect(userRan).toHaveBeenCalledTimes(1);
    const [letter] = await deadLetters(t);
    expect(letter).toMatchObject({ workId: a, resultAvailable: true });

    // The failed attempt's writes rolled back, so retrying it is safe.
    await t.mutation(internal.deadLetter.retry, { id: letter!.id });
    await drive(t, 10 * SECOND);
    expect(userRan).toHaveBeenCalledTimes(2);
    expect(onCompleteRan.mock.calls).toEqual([["A", "success"]]);
    await expectFinished(t, a);
    expect(await deadLetters(t)).toEqual([]);
  });

  it("discards a dead letter without running its onComplete", async () => {
    const t = setup();
    const a = await enqueue(t, "A");
    completeFaults.set(a, 1);

    await drive(t, 10 * MINUTE);
    const [letter] = await deadLetters(t);
    await t.mutation(internal.deadLetter.discard, { id: letter!.id });

    expect(onCompleteRan).not.toHaveBeenCalled();
    await expectFinished(t, a);
    expect(await deadLetters(t)).toEqual([]);
  });

  it("holds a slot for each canceled job's completion", async () => {
    const t = setup();
    const h = await handles(t);
    const N = 20;
    await t.mutation(api.lib.enqueueBatch, {
      config,
      items: Array.from({ length: N }, (_, i) => ({
        fnHandle: h.work,
        fnName: `F${i}`,
        fnArgs: { name: `F${i}` },
        fnType: "mutation" as const,
        runAt: Date.now() + 60 * MINUTE,
        onComplete: { fnHandle: h.onComplete, context: `F${i}` },
      })),
    });
    await t.mutation(api.lib.cancelAll, {
      logLevel: "ERROR",
      limit: N,
      before: Number.MAX_SAFE_INTEGER,
    });
    const b = await enqueue(t, "B");

    // Their canceled onCompletes run well before their runAt, but never more
    // than maxParallelism at a time.
    await drive(t, 2 * MINUTE);
    const kinds = onCompleteRan.mock.calls.map(([, kind]) => kind);
    expect(kinds.filter((k) => k === "canceled")).toHaveLength(N);
    expect(onCompleteRan.mock.calls).toContainEqual(["B", "success"]);
    expect(userRan.mock.calls.map(([name]) => name)).toEqual(["B"]);
    await expectFinished(t, b);
  });

  it("dead-letters a canceled job whose completion failed, freeing its slot", async () => {
    const t = setup();
    const a = await enqueue(t, "A", { runAt: Date.now() + 60 * MINUTE });
    canceledCompleteFaults = 1;
    await t.mutation(api.lib.cancel, { id: a, logLevel: "ERROR" });
    await drive(t, 10 * SECOND);
    const b = await enqueue(t, "B");

    // A's canceled completion holds the slot until recovery finds it failed.
    await drive(t, MINUTE);
    expect(userRan).not.toHaveBeenCalled();
    expect((await internalState(t))?.running).toMatchObject([{ workId: a }]);

    await drive(t, 10 * MINUTE);
    expect(onCompleteRan.mock.calls).toEqual([["B", "success"]]);
    await expectFinished(t, b);
    const [letter] = await deadLetters(t);
    expect(letter).toMatchObject({ workId: a, resultAvailable: true });

    await t.mutation(internal.deadLetter.retry, { id: letter!.id });
    await drive(t, 10 * SECOND);
    expect(onCompleteRan.mock.calls).toEqual([
      ["B", "success"],
      ["A", "canceled"],
    ]);
    await expectFinished(t, a, b);
  });

  it("dead-letters a mutation whose completion was lost before completionId existed", async () => {
    const t = setup();
    const a = await enqueue(t, "A");
    completeFaults.set(a, 1);
    const b = await enqueue(t, "B");

    // A's wrapper succeeds and its `complete` fails. Clearing completionId
    // leaves A as an older `runMutationWrapper` left it.
    await drive(t, 10 * SECOND);
    const completionId = await t.run(async (ctx) => {
      const work = await ctx.db.get("work", a);
      expect(work?.completionId).toBeDefined();
      await ctx.db.patch("work", a, { completionId: undefined });
      return work!.completionId;
    });
    expect(onCompleteRan).not.toHaveBeenCalled();

    await drive(t, 10 * MINUTE);

    expect(userRan.mock.calls.map(([name]) => name)).toEqual(["A", "B"]);
    expect(onCompleteRan.mock.calls).toEqual([["B", "success"]]);
    await expectFinished(t, b);
    // Recovery found the lost completion, so the result can be retried.
    const [letter] = await deadLetters(t);
    expect(letter).toMatchObject({ workId: a, resultAvailable: true });
    const stored = await t.run((ctx) => ctx.db.get("deadLetter", letter!.id));
    expect(stored?.completionId).toBe(completionId);
  });

  it("can't retry a dead letter whose result is gone", async () => {
    const t = setup();
    const id = await t.run(async (ctx) => {
      const workId = await ctx.db.insert("work", {
        fnType: "mutation",
        fnHandle: "handle",
        fnName: "A",
        fnArgs: {},
        attempts: 0,
      });
      return ctx.db.insert("deadLetter", {
        workId,
        attempt: 0,
        error: "completion not found",
      });
    });
    expect(await deadLetters(t)).toMatchObject([{ resultAvailable: false }]);
    await expect(t.mutation(internal.deadLetter.retry, { id })).rejects.toThrow(
      /no longer available/,
    );
    expect(await deadLetters(t)).toHaveLength(1);
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
      deadLetters: (await ctx.db.query("deadLetter").collect()).map(
        (d) => d.workId,
      ),
      recovers: (await ctx.db.system.query("_scheduled_functions").collect())
        .filter((f) => f.name.includes("recover") && f.state.kind === "pending")
        .map((f) => (f.args[0] as { jobs: { workId: string }[] }).jobs),
    }));
    // The first three fill the budget and are dead-lettered here; the fourth
    // waits for the next recover call.
    expect(after.deadLetters).toEqual(ids.slice(0, 3).map((i) => i.workId));
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
      deadLetters: await ctx.db.query("deadLetter").collect(),
      completions: (
        await ctx.db.system.query("_scheduled_functions").collect()
      ).filter((f) => f.name.includes("complete")),
    }));
    expect(after.work?.completionId).toBe(job.completionId);
    expect(after.deadLetters).toEqual([]);
    expect(after.completions).toHaveLength(1);
  });
});
