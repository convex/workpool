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

/**
 * What a job was doing when the first cancel or cancelAll covering it
 * committed. `cancelSnapshots` reads it from the component's tables just
 * before sending the cancel; convex-test runs scheduled functions only from
 * fake timers, and no timer fires between that read and the cancel's commit.
 * A worker already past its `inProgress` mark may still be loading modules
 * (real async) and reach `beginAttempt` after the cancel, so the attempt the
 * cancel can't stop is read from the work row, not from harness starts.
 */
type CancelSnapshot = {
  /** Harness `seq` when the cancel was sent; later starts have a higher one. */
  seq: number;
  /** The work row was already gone, so `shouldCancelWorkItem` in lib.ts no-ops. */
  finished: boolean;
  /** Attempts the harness saw start before the cancel. */
  runs: number;
  /**
   * If the job was in internalState.running, the attempt number that entry
   * is for: `work.attempts + 1` while `complete` hasn't counted it, or
   * `work.attempts` once `complete` has written its pendingCompletion.
   * Undefined if the job was waiting in pendingStart.
   */
  runningAttempt: number | undefined;
  /** State of the running entry's scheduled worker, for error messages. */
  workerState: string | undefined;
};

type ModelJob = {
  spec: JobSpec;
  op: EnqueueOp;
  id: WorkId;
  cancel: CancelSnapshot | undefined;
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

/**
 * The one outcome the model allows, given what the job was doing at cancel
 * time. A cancel that finds the job waiting in pendingStart ends it with no
 * further starts (`handleCancelation` in loop.ts deletes the pendingStart).
 * A cancel that finds it in internalState.running can't stop that attempt:
 * a dispatched worker still starts it, and nothing else may start after
 * (`rescheduleJob` in loop.ts refuses work with a pendingCancelation or
 * `canceled` flag). That attempt then ends the job "canceled" if it would
 * have been retried, or with its natural result if it was the last one.
 */
function expectedOutcome(job: ModelJob): {
  runs: number;
  /** Starts allowed after the cancel was sent; checked only if it reached the job. */
  lateStarts: number;
  result: RunResult;
} {
  const natural = naturalOutcome(job);
  const c = job.cancel;
  if (!c || c.finished) {
    return { runs: natural.runs, lateStarts: 0, result: natural.result };
  }
  if (c.runningAttempt === undefined) {
    return { runs: c.runs, lateStarts: 0, result: { kind: "canceled" } };
  }
  const runs = c.runningAttempt;
  return {
    runs,
    lateStarts: runs - c.runs,
    result: runs < natural.runs ? { kind: "canceled" } : natural.result,
  };
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

/** Reads each job's state for a cancel about to be sent; see CancelSnapshot. */
async function cancelSnapshots(
  t: T,
  ids: WorkId[],
): Promise<Omit<CancelSnapshot, "seq" | "runs">[]> {
  return await t.runInComponent(POOL, async (ctx) => {
    const db = ctx.db as unknown as ComponentCtx["db"] & {
      get: (id: string) => Promise<{ attempts: number } | null>;
      system: { get: (id: string) => Promise<{ state: { kind: string } }> };
    };
    const running = ((await db.query("internalState").collect())[0]?.running ??
      []) as { workId: string; scheduledId: string }[];
    const pendingCompletion = (await db
      .query("pendingCompletion")
      .collect()) as { workId: string }[];
    return await Promise.all(
      ids.map(async (id) => {
        const work = await db.get(id);
        const entry = running.find((r) => r.workId === id);
        if (!work || !entry) {
          return {
            finished: !work,
            runningAttempt: undefined,
            workerState: undefined,
          };
        }
        const completed = pendingCompletion.some((p) => p.workId === id);
        return {
          finished: false,
          runningAttempt: work.attempts + (completed ? 0 : 1),
          workerState: (await db.system.get(entry.scheduledId))?.state.kind,
        };
      }),
    );
  });
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
    const job: ModelJob = { spec, op, id, cancel: undefined };
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

  // Records the state of each job not yet covered by a cancel, then sends it.
  const sendCancel = async (
    targets: ModelJob[],
    send: () => Promise<unknown>,
  ) => {
    const fresh = targets.filter((j) => !j.cancel);
    const snaps = await cancelSnapshots(
      t,
      fresh.map((j) => j.id),
    );
    for (const [i, job] of fresh.entries()) {
      job.cancel = {
        ...snaps[i]!,
        seq: ++h.seq,
        runs: h.starts.get(job.spec.key)?.length ?? 0,
      };
    }
    await send();
  };

  for (const [step, op] of scenario.ops.entries()) {
    switch (op.type) {
      case "enqueue":
        await enqueue(op);
        break;
      case "cancel": {
        const job = jobs[op.index % Math.max(1, jobs.length)];
        if (!job) break;
        await sendCancel([job], () =>
          t.mutation(api.test.proptest.cancel, { id: job.id }),
        );
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
        await sendCancel(jobs, () =>
          t.mutation(api.test.proptest.cancelAll, {}),
        );
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
    const expected = expectedOutcome(job);
    if (runs !== expected.runs) {
      err(`ran ${runs} times, expected ${expected.runs}`);
    }
    const c = job.cancel;
    if (c && !c.finished) {
      const late = starts.filter((s) => s > c.seq).length;
      const at =
        c.runningAttempt === undefined
          ? "pendingStart"
          : `running attempt ${c.runningAttempt}, worker ${c.workerState}`;
      if (expected.lateStarts < 0 || expected.lateStarts > 1) {
        err(`${c.runs} starts seen at cancel but ${at}`);
      } else if (late > expected.lateStarts) {
        err(
          `${late} attempts started after cancel, allowed ${expected.lateStarts} (${at} at cancel)`,
        );
      }
    }

    const calls = h.onCompleteCalls.filter((c) => c.key === key);
    const rows = committed.filter((c) => c.key === key);
    const onComplete = job.op.onComplete;
    if (!onComplete) {
      if (calls.length) err(`onComplete called without one configured`);
      continue;
    }
    const expectedKind = expected.result.kind;
    if (onComplete.excludeKinds.includes(expectedKind)) {
      if (calls.length) {
        err(
          `onComplete called ${calls.length} times for excluded ${expectedKind}`,
        );
      }
      continue;
    }
    const results = new Set(calls.map((c) => canonical(c.result)));
    if (results.size > 1)
      err(`onComplete got differing results ${[...results]}`);
    const result = calls[0]?.result;
    if (!result) {
      err(`onComplete never called, expected ${expectedKind}`);
      continue;
    }
    if (onComplete.throws) {
      if (rows.length)
        err(`throwing onComplete committed ${rows.length} times`);
      // An action or query that succeeds runs `complete` with
      // runOnCompleteInline (`runOne` in worker.ts); the inline onComplete
      // throws, so complete.ts schedules it once more. Every other result
      // schedules it once.
      const invocations =
        expectedKind === "success" && job.op.kind !== "mutation" ? 2 : 1;
      if (calls.length !== invocations) {
        err(
          `throwing onComplete called ${calls.length} times, expected ${invocations}`,
        );
      }
    } else {
      // The poisoned job's onComplete also runs inside each `complete` that
      // the spy rolls back, so only its committed count is meaningful.
      if (calls.length !== 1 && !poisonedWorkIds.has(job.id)) {
        err(`onComplete called ${calls.length} times`);
      }
      if (rows.length !== 1) err(`onComplete committed ${rows.length} times`);
    }
    const { errorData: _ignored, ...comparable } = result as RunResult & {
      errorData?: unknown;
    };
    if (canonical(comparable) !== canonical(expected.result)) {
      err(
        `onComplete result ${canonical(comparable)}, expected ${canonical(expected.result)}`,
      );
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
 * Tests for known bugs assert the buggy outcome exactly, so they pass on main
 * and fail once the bug is fixed (or starts failing some other way). Run with
 * PROPTEST_SHOW_KNOWN_BUGS=1 to assert the correct outcome instead and see
 * the bug as a failure.
 */
const showKnownBugs = !!process.env.PROPTEST_SHOW_KNOWN_BUGS;

/**
 * PROPTEST_RUNS=n raises the random test's run count for longer hunts; unset,
 * empty or not a positive integer means 400. A run takes roughly 0.1-0.3s, so
 * the timeout allows 1s per run with a 120s floor.
 */
const DEFAULT_RUNS = 400;
const envRuns = Number(process.env.PROPTEST_RUNS);
const numRuns =
  Number.isInteger(envRuns) && envRuns > 0 ? envRuns : DEFAULT_RUNS;
const randomTimeoutMs = Math.max(120_000, numRuns * 1_000);

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

  it(
    "random operation sequences keep every invariant",
    async () => {
      await fc.assert(
        fc.asyncProperty(scenarioArb, async (scenario) => {
          expect(await runScenario(scenario)).toEqual([]);
        }),
        { numRuns },
      );
    },
    randomTimeoutMs,
  );

  // Found by the property above (shrunk): `cancelAll` in src/component/lib.ts
  // picks work with `_creationTime <= (before ?? Date.now())`. Work enqueued
  // in the same millisecond can have a `_creationTime` a fraction above that
  // mutation's Date.now(), so it is skipped and runs anyway. Here j2's
  // _creationTime is T+0.002 while cancelAll sees Date.now() = T. This is
  // convex-test's clock; whether a real deployment hands out creation times
  // ahead of a later mutation's Date.now() is unverified. Known bug: this
  // asserts j2 runs and succeeds; it fails once cancelAll catches j2, and
  // then should assert the `fixed` outcome.
  it("cancelAll skips work enqueued just before it (known bug)", async () => {
    const h = installHarness(1);
    const t = initConvexTest() as T;
    workpool.register(t, POOL);
    await t.mutation(api.test.proptest.setMaxParallelism, {
      maxParallelism: 1,
    });
    for (const key of ["j0", "j1", "j2"]) {
      h.jobs.set(key, {
        key,
        kind: "action",
        attempts: ["ok"],
        delaysMs: [],
        onCompleteThrows: false,
      });
      await t.mutation(api.test.proptest.enqueue, {
        key,
        kind: "action",
        withOnComplete: true,
        maxParallelism: 1,
      });
    }
    // The test clock moves 1ms but stays behind convex-test's mutation
    // clock, which runs ahead of a frozen fake clock (see the cancelAll op
    // in runScenario).
    vi.setSystemTime(Date.now() + 1);
    await t.mutation(api.test.proptest.cancelAll, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const outcome = {
      started: [...h.starts.keys()].sort(),
      onComplete: h.onCompleteCalls.map((c) => [c.key, c.result.kind]).sort(),
    };
    // No job had started, so all should end canceled without running.
    const fixed = {
      started: [],
      onComplete: [
        ["j0", "canceled"],
        ["j1", "canceled"],
        ["j2", "canceled"],
      ],
    };
    const buggy = {
      started: ["j2"],
      onComplete: [
        ["j0", "canceled"],
        ["j1", "canceled"],
        ["j2", "success"],
      ],
    };
    expect(outcome).toEqual(showKnownBugs ? fixed : buggy);
  });

  // Lost completion: an action succeeds, so `completeInline` in
  // src/component/worker.ts calls `complete` with runOnCompleteInline: true.
  // Here that `complete` fails as a whole whenever it runs the onComplete
  // inline, standing in for an onComplete that hits a timeout or transaction
  // limit the try/catch in complete.ts can't catch. On main the fallback
  // `ctx.scheduler.runAfter(0, internal.complete.complete, { jobs: [job] })`
  // keeps runOnCompleteInline: true, fails the same way, and the job keeps
  // its slot in internalState.running forever. Fixed by #281
  // (fix/inline-oncomplete-fallback). Known bug: this asserts the stuck slot
  // for the poisoned job j0 and nothing else; it fails once #281 lands, and
  // then should expect no errors.
  it("an action whose inline complete always fails keeps its slot (#281, known bug)", async () => {
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
    // j0 is the poisoned job; j1 is an ordinary action beside it, to show
    // only the poisoned job is stuck.
    const errors = await runScenario(
      {
        maxParallelism: 2,
        ops: [
          {
            type: "enqueue",
            kind: "action",
            maxAttempts: 2,
            onComplete: { throws: false, excludeKinds: [] },
            attempts: ["throw", "ok", "ok", "ok"],
            delaysMs: [0, 0, 0, 0],
          },
          { type: "advance", ms: 1000 },
        ],
      },
      { poisonedJob: true },
    );
    const buggy = [
      // finishAllScheduledFunctions gives up: the main loop keeps polling
      // the running slot that never frees.
      "did not quiesce",
      "after drain, work still has rows for j0",
      "after drain, running still has rows for j0",
      'j0: status {"previousAttempts":0,"state":"running"}, expected finished',
      "j0: onComplete committed 0 times",
    ];
    expect(
      errors.map((e) =>
        e.startsWith("did not quiesce") ? "did not quiesce" : e,
      ),
    ).toEqual(showKnownBugs ? [] : buggy);
  }, 60_000);
});
