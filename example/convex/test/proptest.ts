/**
 * Functions driven by proptest.test.ts: the jobs it enqueues on the
 * `testWorkpool` component and their onComplete handler.
 *
 * What each job does on each attempt is decided by the test, not by these
 * functions' args: convex-test runs these handlers in the same JS process as
 * the test, so `jobAction`, `jobMutation` and `jobQuery` look the job up by
 * `key` in `globalThis.__workpoolProptest` (a `PropHarness`) and record every
 * start and finish there. Those records are what the test's invariants read.
 */
import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "../_generated/server";
import { components, internal } from "../_generated/api";
import {
  NonRetryableError,
  Workpool,
  vOnCompleteArgs,
  vWorkId,
  type RunResult,
  type WorkId,
} from "@convex-dev/workpool";

/** What one attempt of a job does: return, throw, or throw NonRetryableError. */
export type AttemptBehavior = "ok" | "throw" | "nonRetryable";

export type JobSpec = {
  key: string;
  kind: "action" | "mutation" | "query";
  /** Behaviour of attempt 1, 2, ...; attempts past the end return "ok". */
  attempts: AttemptBehavior[];
  /** How long each action attempt awaits a (fake) setTimeout before acting. */
  delaysMs: number[];
  onCompleteThrows: boolean;
};

/** One onComplete invocation, committed or not (the handler may throw). */
export type OnCompleteCall = { key: string; result: RunResult };

export type PropHarness = {
  jobs: Map<string, JobSpec>;
  /** Attempt starts per key, in order, with the global start sequence number. */
  starts: Map<string, number[]>;
  /** Monotonic counter bumped on every job start and every cancel request. */
  seq: number;
  inFlight: number;
  inFlightByKey: Map<string, number>;
  /** Invariant breaks seen by `beginAttempt`, checked by the test. */
  violations: string[];
  /** Highest maxParallelism the pool may be using; set by the test. */
  allowedParallelism: number;
  onCompleteCalls: OnCompleteCall[];
};

declare global {
  var __workpoolProptest: PropHarness | undefined;
}

function harness(): PropHarness {
  const h = globalThis.__workpoolProptest;
  if (!h) throw new Error("proptest harness not installed");
  return h;
}

/**
 * Called at the top of every job function. Records the start, checks the
 * in-flight count against `allowedParallelism`, and returns this attempt's
 * number and behaviour.
 */
function beginAttempt(key: string) {
  const h = harness();
  const spec = h.jobs.get(key);
  if (!spec) throw new Error(`unknown job ${key}`);
  const starts = h.starts.get(key) ?? [];
  starts.push(++h.seq);
  h.starts.set(key, starts);
  const attempt = starts.length;
  h.inFlight++;
  const sameKey = (h.inFlightByKey.get(key) ?? 0) + 1;
  h.inFlightByKey.set(key, sameKey);
  if (h.inFlight > h.allowedParallelism) {
    h.violations.push(
      `${h.inFlight} jobs in flight when ${key} attempt ${attempt} started; allowed ${h.allowedParallelism}`,
    );
  }
  if (sameKey > 1) {
    h.violations.push(`${key} has ${sameKey} attempts running at once`);
  }
  return {
    attempt,
    behavior: spec.attempts[attempt - 1] ?? "ok",
    delayMs: spec.delaysMs[attempt - 1] ?? 0,
  };
}

function endAttempt(key: string, attempt: number, behavior: AttemptBehavior) {
  const h = harness();
  h.inFlight--;
  h.inFlightByKey.set(key, (h.inFlightByKey.get(key) ?? 1) - 1);
  if (behavior === "throw") throw new Error(`fail ${key} #${attempt}`);
  if (behavior === "nonRetryable") {
    throw new NonRetryableError(`terminal ${key} #${attempt}`);
  }
  return { key, attempt };
}

export const jobAction = internalAction({
  args: { key: v.string() },
  handler: async (_ctx, { key }) => {
    const { attempt, behavior, delayMs } = beginAttempt(key);
    // A fake-timer sleep keeps the attempt in flight across test steps, so
    // other jobs can start alongside it and the parallelism check has
    // something to count.
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    return endAttempt(key, attempt, behavior);
  },
});

export const jobMutation = internalMutation({
  args: { key: v.string() },
  handler: async (_ctx, { key }) => {
    const { attempt, behavior } = beginAttempt(key);
    return endAttempt(key, attempt, behavior);
  },
});

export const jobQuery = internalQuery({
  args: { key: v.string() },
  handler: async (_ctx, { key }) => {
    const { attempt, behavior } = beginAttempt(key);
    return endAttempt(key, attempt, behavior);
  },
});

/**
 * Records every call in the harness, then either throws (so the write below
 * rolls back) or inserts a `data` row. The test counts the rows to know how
 * many onComplete calls committed.
 */
export const onComplete = internalMutation({
  args: vOnCompleteArgs(v.object({ key: v.string() })),
  handler: async (ctx, { context, result }) => {
    const h = harness();
    h.onCompleteCalls.push({ key: context.key, result });
    if (h.jobs.get(context.key)?.onCompleteThrows) {
      throw new Error(`onComplete for ${context.key} throws`);
    }
    await ctx.db.insert("data", {
      misc: { kind: "proptestOnComplete", key: context.key, result },
    });
  },
});

export const committedOnCompletes = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("data").collect();
    return rows.flatMap((row) =>
      row.misc?.kind === "proptestOnComplete"
        ? [row.misc as { key: string; result: RunResult }]
        : [],
    );
  },
});

const vKind = v.union(
  v.literal("success"),
  v.literal("failed"),
  v.literal("canceled"),
);

export const enqueue = mutation({
  args: {
    key: v.string(),
    kind: v.union(
      v.literal("action"),
      v.literal("mutation"),
      v.literal("query"),
    ),
    // Action retry policy; undefined means `retry: false`.
    maxAttempts: v.optional(v.number()),
    withOnComplete: v.boolean(),
    excludeKinds: v.optional(v.array(vKind)),
    maxParallelism: v.number(),
  },
  handler: async (ctx, args): Promise<WorkId> => {
    // Workpool's client sends `maxParallelism` with every enqueue and
    // `lib.enqueue` writes it to `globals`, so the test passes its current
    // value each time to keep it from being reset.
    const pool = new Workpool(components.testWorkpool, {
      maxParallelism: args.maxParallelism,
      logLevel: "ERROR",
    });
    const options = args.withOnComplete
      ? {
          onComplete: internal.test.proptest.onComplete,
          context: { key: args.key },
          onCompleteExcludeKinds: args.excludeKinds,
        }
      : {};
    const fnArgs = { key: args.key };
    if (args.kind === "action") {
      return await pool.enqueueAction(
        ctx,
        internal.test.proptest.jobAction,
        fnArgs,
        {
          ...options,
          retry:
            args.maxAttempts === undefined
              ? false
              : {
                  maxAttempts: args.maxAttempts,
                  initialBackoffMs: 10,
                  base: 2,
                },
        },
      );
    }
    if (args.kind === "mutation") {
      return await pool.enqueueMutation(
        ctx,
        internal.test.proptest.jobMutation,
        fnArgs,
        options,
      );
    }
    return await pool.enqueueQuery(
      ctx,
      internal.test.proptest.jobQuery,
      fnArgs,
      options,
    );
  },
});

function pool() {
  return new Workpool(components.testWorkpool, { logLevel: "ERROR" });
}

export const cancel = mutation({
  args: { id: vWorkId },
  handler: async (ctx, { id }) => {
    await pool().cancel(ctx, id);
  },
});

export const cancelAll = mutation({
  args: {},
  handler: async (ctx) => {
    await pool().cancelAll(ctx);
  },
});

export const setMaxParallelism = mutation({
  args: { maxParallelism: v.number() },
  handler: async (ctx, { maxParallelism }) => {
    await ctx.runMutation(components.testWorkpool.config.update, {
      maxParallelism,
    });
  },
});

export const statuses = query({
  args: { ids: v.array(vWorkId) },
  handler: async (ctx, { ids }) => {
    return await pool().statusBatch(ctx, ids);
  },
});
