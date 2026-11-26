/// <reference types="vite/client" />
/**
 * Property-based tests: fast-check generates random sequences of enqueue,
 * cancel, cancelAll, maxParallelism changes and clock advances, runs them
 * end to end through the Workpool client against the `testWorkpool`
 * component in convex-test, and checks invariants after every step and once
 * everything has drained. The job functions live in ./proptest.ts and report
 * each attempt to a harness object on `globalThis`.
 */
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import workpool from "@convex-dev/workpool/test";
import type { RunResult, WorkId } from "@convex-dev/workpool";
import { api } from "../_generated/api";
import { initConvexTest } from "../setup.test";
import { complete } from "../../../src/component/complete";
import type { CompleteJob } from "../../../src/component/complete";
import type { AttemptBehavior, JobSpec, PropHarness } from "./proptest";

type Kind = RunResult["kind"];

type EnqueueOp = {
  type: "enqueue";
  kind: JobSpec["kind"];
  // Only actions take a retry policy in the Workpool client.
  maxAttempts: number | undefined;
  onComplete: { throws: boolean; excludeKinds: Kind[] } | null;
  attempts: AttemptBehavior[];
  delaysMs: number[];
};
type Op =
  | EnqueueOp
  | { type: "cancel"; index: number }
  | { type: "cancelAll" }
  | { type: "setMaxParallelism"; value: number }
  | { type: "advance"; ms: number };

const kindArb = fc.constantFrom<Kind>("success", "failed", "canceled");
const enqueueArb: fc.Arbitrary<EnqueueOp> = fc.record({
  type: fc.constant("enqueue" as const),
  kind: fc.constantFrom<JobSpec["kind"]>(
    "action",
    "action",
    "mutation",
    "query",
  ),
  maxAttempts: fc.option(fc.integer({ min: 1, max: 4 }), { nil: undefined }),
  onComplete: fc.option(
    fc.record({
      throws: fc.oneof(
        { weight: 4, arbitrary: fc.constant(false) },
        { weight: 1, arbitrary: fc.constant(true) },
      ),
      excludeKinds: fc.oneof(
        { weight: 4, arbitrary: fc.constant<Kind[]>([]) },
        { weight: 1, arbitrary: fc.uniqueArray(kindArb, { maxLength: 2 }) },
      ),
    }),
    { nil: null, freq: 4 },
  ),
  attempts: fc.array(
    fc.constantFrom<AttemptBehavior>(
      "ok",
      "ok",
      "throw",
      "throw",
      "nonRetryable",
    ),
    { minLength: 4, maxLength: 4 },
  ),
  delaysMs: fc.array(fc.constantFrom(0, 0, 5, 50, 200), {
    minLength: 4,
    maxLength: 4,
  }),
});
const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 6, arbitrary: enqueueArb },
  {
    weight: 2,
    arbitrary: fc.record({
      type: fc.constant("cancel" as const),
      index: fc.nat({ max: 30 }),
    }),
  },
  { weight: 1, arbitrary: fc.constant({ type: "cancelAll" as const }) },
  {
    weight: 1,
    arbitrary: fc.record({
      type: fc.constant("setMaxParallelism" as const),
      value: fc.integer({ min: 1, max: 4 }),
    }),
  },
  {
    weight: 5,
    arbitrary: fc.record({
      type: fc.constant("advance" as const),
      ms: fc.constantFrom(0, 1, 10, 50, 100, 300, 1000),
    }),
  },
);
const scenarioArb = fc.record({
  maxParallelism: fc.integer({ min: 1, max: 4 }),
  ops: fc.array(opArb, { minLength: 1, maxLength: 25 }),
});

type ModelJob = {
  spec: JobSpec;
  op: EnqueueOp;
  id: WorkId;
  /** Harness `seq` when the first cancel/cancelAll covering this job was sent. */
  cancelSeq: number | undefined;
};

/** The outcome if nobody cancels: which attempt ends the job, and how. */
function naturalOutcome(job: ModelJob): {
  runs: number;
  result: RunResult;
} {
  const { op, spec } = job;
  // `complete` in src/component/complete.ts retries only when the work has a
  // retryBehavior, so mutations, queries and `retry: false` actions get one
  // attempt.
  const max = op.kind === "action" && op.maxAttempts ? op.maxAttempts : 1;
  for (let i = 1; i <= max; i++) {
    const b = op.attempts[i - 1] ?? "ok";
    if (b === "ok") {
      return {
        runs: i,
        result: { kind: "success", returnValue: { key: spec.key, attempt: i } },
      };
    }
    if (b === "nonRetryable") {
      return {
        runs: i,
        result: { kind: "failed", error: `terminal ${spec.key} #${i}` },
      };
    }
    if (i === max) {
      return {
        runs: i,
        result: { kind: "failed", error: `fail ${spec.key} #${i}` },
      };
    }
  }
  throw new Error("unreachable");
}

/** JSON with sorted object keys, so results compare regardless of key order. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : v,
  );
}

/** The fields of component rows this file reads (every table has one). */
type Row = { _id: string; workId?: string };
type ComponentCtx = {
  db: { query: (table: string) => { collect: () => Promise<any[]> } };
};
type T = ReturnType<typeof initConvexTest> & {
  // convex-test's accessor has runInComponent at runtime but its type omits
  // it; it runs the handler against a component's own tables.
  runInComponent: <R>(
    path: string,
    fn: (ctx: ComponentCtx) => Promise<R>,
  ) => Promise<R>;
};

const POOL = "testWorkpool";

async function componentTables(t: T) {
  return await t.runInComponent(POOL, async (ctx) => ({
    work: await ctx.db.query("work").collect(),
    pendingStart: await ctx.db.query("pendingStart").collect(),
    pendingCompletion: await ctx.db.query("pendingCompletion").collect(),
    pendingCancelation: await ctx.db.query("pendingCancelation").collect(),
    payload: await ctx.db.query("payload").collect(),
    running: ((await ctx.db.query("internalState").collect())[0]?.running ??
      []) as Row[],
  }));
}

function installHarness(maxParallelism: number): PropHarness {
  const h: PropHarness = {
    jobs: new Map(),
    starts: new Map(),
    seq: 0,
    inFlight: 0,
    inFlightByKey: new Map(),
    violations: [],
    allowedParallelism: maxParallelism,
    onCompleteCalls: [],
  };
  globalThis.__workpoolProptest = h;
  return h;
}

type ScenarioOptions = {
  /** Enqueued before `ops`: an always-succeeding action whose `complete` is poisoned. */
  poisonedJob?: boolean;
};

/**
 * Runs `ops` against a fresh convex-test instance and returns the list of
 * invariant violations found (empty means the property holds).
 */
async function runScenario(
  scenario: { maxParallelism: number; ops: Op[] },
  options: ScenarioOptions = {},
): Promise<string[]> {
  vi.clearAllTimers();
  const h = installHarness(scenario.maxParallelism);
  const t = initConvexTest() as T;
  workpool.register(t, POOL);
  const errors: string[] = [];
  const jobs: ModelJob[] = [];
  let maxParallelism = scenario.maxParallelism;
  await t.mutation(api.test.proptest.setMaxParallelism, { maxParallelism });

  const enqueue = async (op: EnqueueOp) => {
    const spec: JobSpec = {
      key: `j${jobs.length}`,
      kind: op.kind,
      attempts: op.attempts,
      delaysMs: op.kind === "action" ? op.delaysMs : [],
      onCompleteThrows: op.onComplete?.throws ?? false,
    };
    h.jobs.set(spec.key, spec);
    const id = (await t.mutation(api.test.proptest.enqueue, {
      key: spec.key,
      kind: op.kind,
      maxAttempts: op.kind === "action" ? op.maxAttempts : undefined,
      withOnComplete: op.onComplete !== null,
      excludeKinds: op.onComplete?.excludeKinds,
      maxParallelism,
    })) as WorkId;
    const job = { spec, op, id, cancelSeq: undefined };
    jobs.push(job);
    return job;
  };

  if (options.poisonedJob) {
    const job = await enqueue({
      type: "enqueue",
      kind: "action",
      maxAttempts: undefined,
      onComplete: { throws: false, excludeKinds: [] },
      attempts: ["ok"],
      delaysMs: [0],
    });
    poisonedWorkIds.add(job.id);
  }

  for (const [step, op] of scenario.ops.entries()) {
    switch (op.type) {
      case "enqueue":
        await enqueue(op);
        break;
      case "cancel": {
        const job = jobs[op.index % Math.max(1, jobs.length)];
        if (!job) break;
        job.cancelSeq ??= ++h.seq;
        await t.mutation(api.test.proptest.cancel, { id: job.id });
        break;
      }
      case "cancelAll":
        // `cancelAll` in src/component/lib.ts only cancels work with
        // `_creationTime <= Date.now()`. Under fake timers the clock stands
        // still while convex-test's mutation clock runs up to 1ms ahead of
        // it (TransactionManager.begin rounds the last commit up to the next
        // ms), so work enqueued just before can be skipped (see the
        // "cancelAll skips work" regression test below). Move the clock 5ms,
        // without firing timers, so this op tests cancelation, not that edge.
        vi.setSystemTime(Date.now() + 5);
        for (const job of jobs) job.cancelSeq ??= ++h.seq;
        await t.mutation(api.test.proptest.cancelAll, {});
        break;
      case "setMaxParallelism":
        maxParallelism = op.value;
        // Lowering the limit doesn't stop jobs already running (and
        // `getBatch` in loop.ts reads globals in a query, so a batch planned
        // before the change can still start); allow the old limit until the
        // pool next drains.
        h.allowedParallelism = Math.max(h.allowedParallelism, op.value);
        await t.mutation(api.test.proptest.setMaxParallelism, {
          maxParallelism,
        });
        break;
      case "advance":
        await vi.advanceTimersByTimeAsync(op.ms);
        break;
    }
    const tables = await componentTables(t);
    if (tables.running.length > h.allowedParallelism) {
      errors.push(
        `step ${step}: internalState.running has ${tables.running.length} > ${h.allowedParallelism}`,
      );
    }
    if (tables.running.length === 0 && h.inFlight === 0) {
      h.allowedParallelism = maxParallelism;
    }
    if (errors.length || h.violations.length) {
      return [...errors, ...h.violations];
    }
  }

  try {
    await t.finishAllScheduledFunctions(vi.runAllTimers, 300);
  } catch (e) {
    errors.push(`did not quiesce: ${String(e).slice(0, 200)}`);
  }
  errors.push(...h.violations);

  const tables = await componentTables(t);
  for (const table of [
    "work",
    "pendingStart",
    "pendingCompletion",
    "pendingCancelation",
    "payload",
    "running",
  ] as const) {
    if (tables[table].length > 0) {
      const keys = tables[table].map(
        (row: Row) =>
          jobs.find((j) => j.id === (row.workId ?? row._id))?.spec.key ??
          row._id,
      );
      errors.push(`after drain, ${table} still has rows for ${keys.join(",")}`);
    }
  }
  const statuses = await t.query(api.test.proptest.statuses, {
    ids: jobs.map((j) => j.id),
  });
  const committed = await t.query(api.test.proptest.committedOnCompletes, {});

  for (const [i, job] of jobs.entries()) {
    const { key } = job.spec;
    const err = (msg: string) => errors.push(`${key}: ${msg}`);
    if (statuses[i]?.state !== "finished") {
      err(`status ${JSON.stringify(statuses[i])}, expected finished`);
    }
    const starts = h.starts.get(key) ?? [];
    const runs = starts.length;
    const natural = naturalOutcome(job);
    const canceled = job.cancelSeq !== undefined;
    if (!canceled && runs !== natural.runs) {
      err(`ran ${runs} times, expected ${natural.runs}`);
    }
    if (canceled) {
      if (runs > natural.runs) err(`ran ${runs} times, max ${natural.runs}`);
      // At most the attempt already scheduled or running when the cancel was
      // sent may start afterwards: `rescheduleJob` and `handleStart` in
      // loop.ts both refuse work with a pendingCancelation or `canceled` flag.
      const late = starts.filter((s) => s > job.cancelSeq!).length;
      if (late > 1) err(`${late} attempts started after cancel`);
    }

    const calls = h.onCompleteCalls.filter((c) => c.key === key);
    const rows = committed.filter((c) => c.key === key);
    const onComplete = job.op.onComplete;
    if (!onComplete) {
      if (calls.length) err(`onComplete called without one configured`);
      continue;
    }
    const results = new Set(calls.map((c) => canonical(c.result)));
    if (results.size > 1)
      err(`onComplete got differing results ${[...results]}`);
    const result = calls[0]?.result;
    if (!result) {
      // No call: the outcome must be one the caller excluded.
      const possible: Kind[] = canceled
        ? ["canceled", natural.result.kind]
        : [natural.result.kind];
      if (!possible.some((k) => onComplete.excludeKinds.includes(k))) {
        err(`onComplete never called (excluded ${onComplete.excludeKinds})`);
      }
      continue;
    }
    if (onComplete.excludeKinds.includes(result.kind)) {
      err(`onComplete called with excluded kind ${result.kind}`);
    }
    if (onComplete.throws) {
      if (rows.length)
        err(`throwing onComplete committed ${rows.length} times`);
    } else {
      // The poisoned job's onComplete also runs inside each `complete` that
      // the spy rolls back, so only its committed count is meaningful.
      if (calls.length !== 1 && !poisonedWorkIds.has(job.id)) {
        err(`onComplete called ${calls.length} times`);
      }
      if (rows.length !== 1) err(`onComplete committed ${rows.length} times`);
    }
    if (result.kind === "canceled") {
      if (!canceled) err(`canceled without a cancel request`);
      // `complete` reports success or final failure even after a cancel; a
      // job only ends "canceled" before its natural last attempt, after a
      // retryable failure (or before any attempt).
      if (runs >= natural.runs) {
        err(`canceled after ${runs} runs, natural end is run ${natural.runs}`);
      }
      if (runs > 0 && job.op.attempts[runs - 1] !== "throw") {
        err(
          `canceled after attempt ${runs} that was ${job.op.attempts[runs - 1]}`,
        );
      }
    } else {
      if (runs !== natural.runs) {
        err(
          `${result.kind} after ${runs} runs, natural end is ${natural.runs}`,
        );
      }
      const { errorData: _ignored, ...comparable } = result as RunResult & {
        errorData?: unknown;
      };
      if (canonical(comparable) !== canonical(natural.result)) {
        err(
          `onComplete result ${canonical(comparable)}, expected ${canonical(natural.result)}`,
        );
      }
    }
  }
  return errors;
}

/**
 * Work ids whose `complete` mutation fails whenever it would run onComplete
 * inline. The spy on `complete._handler` in the lost-completion test reads it.
 */
const poisonedWorkIds = new Set<string>();

/**
 * convex/server's registration sets `_handler` on each registered function,
 * and convex-test's getHandler reads it on every call, so spying on it
 * changes what `internal.complete.complete` does inside convex-test.
 */
type CompleteHandlerHolder = {
  _handler: (ctx: unknown, args: { jobs: CompleteJob[] }) => Promise<unknown>;
};

/**
 * Tests that fail on main because of a known bug are `it.fails`, so the suite
 * stays green and flips red once the bug is fixed. Run with
 * PROPTEST_SHOW_KNOWN_BUGS=1 to run them as plain `it` and see the failure.
 * PROPTEST_RUNS=n raises the random test's run count for longer hunts.
 */
const knownBug = process.env.PROPTEST_SHOW_KNOWN_BUGS ? it : it.fails;

describe("workpool property tests", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    poisonedWorkIds.clear();
    // Failing jobs log through createLogger and convex-test logs failed
    // scheduled functions; both are expected here and drown the report.
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    globalThis.__workpoolProptest = undefined;
  });

  it("random operation sequences keep every invariant", async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        expect(await runScenario(scenario)).toEqual([]);
      }),
      { numRuns: Number(process.env.PROPTEST_RUNS ?? 400) },
    );
  }, 120_000);

  // Found by the property above (shrunk): `cancelAll` in src/component/lib.ts
  // picks work with `_creationTime <= (before ?? Date.now())`. Work enqueued
  // in the same millisecond can have a `_creationTime` a fraction above that
  // mutation's Date.now(), so it is skipped and runs anyway. Here j2's
  // _creationTime is T+0.002 while cancelAll sees Date.now() = T. This is
  // convex-test's clock; whether a real deployment hands out creation times
  // ahead of a later mutation's Date.now() is unverified. Remove `.fails`
  // once cancelAll catches it.
  knownBug("cancelAll skips work enqueued just before it", async () => {
    const h = installHarness(1);
    const t = initConvexTest() as T;
    workpool.register(t, POOL);
    await t.mutation(api.test.proptest.setMaxParallelism, {
      maxParallelism: 1,
    });
    const ids: WorkId[] = [];
    for (const key of ["j0", "j1", "j2"]) {
      h.jobs.set(key, {
        key,
        kind: "action",
        attempts: ["ok"],
        delaysMs: [],
        onCompleteThrows: false,
      });
      ids.push(
        (await t.mutation(api.test.proptest.enqueue, {
          key,
          kind: "action",
          withOnComplete: true,
          maxParallelism: 1,
        })) as WorkId,
      );
    }
    // The test clock moves 1ms but stays behind convex-test's mutation
    // clock, which runs ahead of a frozen fake clock (see the cancelAll op
    // in runScenario).
    vi.setSystemTime(Date.now() + 1);
    await t.mutation(api.test.proptest.cancelAll, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    // No job had started, so all should end canceled without running.
    expect(h.starts.get("j0")).toBeUndefined();
    expect(h.starts.get("j1")).toBeUndefined();
    expect(h.starts.get("j2")).toBeUndefined();
    expect(h.onCompleteCalls.map((c) => [c.key, c.result.kind]).sort()).toEqual(
      [
        ["j0", "canceled"],
        ["j1", "canceled"],
        ["j2", "canceled"],
      ],
    );
  });

  // Lost completion: an action succeeds, so `completeInline` in
  // src/component/worker.ts calls `complete` with runOnCompleteInline: true.
  // Here that `complete` fails as a whole whenever it runs the onComplete
  // inline, standing in for an onComplete that hits a timeout or transaction
  // limit the try/catch in complete.ts can't catch. On main the fallback
  // `ctx.scheduler.runAfter(0, internal.complete.complete, { jobs: [job] })`
  // keeps runOnCompleteInline: true, fails the same way, and the job keeps
  // its slot in internalState.running forever. Fixed by #281
  // (fix/inline-oncomplete-fallback); remove `.fails` once that lands.
  knownBug(
    "an action whose inline complete always fails still finishes (#281)",
    async () => {
      const registered = complete as unknown as CompleteHandlerHolder;
      const handler = registered._handler;
      vi.spyOn(registered, "_handler").mockImplementation(
        async (ctx: unknown, args: { jobs: CompleteJob[] }) => {
          await handler(ctx, args);
          if (
            args.jobs.some(
              (j) => j.runOnCompleteInline && poisonedWorkIds.has(j.workId),
            )
          ) {
            throw new Error("simulated: inline onComplete hit a limit");
          }
        },
      );
      await fc.assert(
        fc.asyncProperty(scenarioArb, async (scenario) => {
          expect(await runScenario(scenario, { poisonedJob: true })).toEqual(
            [],
          );
        }),
        { numRuns: 20, endOnFailure: true },
      );
    },
    60_000,
  );
});
