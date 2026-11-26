import { getConvexSize, type Infer, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel.js";
import { internal } from "./_generated/api.js";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type MutationCtx,
} from "./_generated/server.js";
import type { SystemDataModel } from "convex/server";
import { createLogger, type Logger } from "./logging.js";
import { type CompleteJob, completeHandler } from "./complete.js";
import { kickMainLoop } from "./kick.js";
import { RECOVERY_BATCH_SIZE, RECOVERY_THRESHOLD_MS } from "./loop.js";

// Re-run a failed completion this many times before giving up on it.
export const MAX_COMPLETION_RERUNS = 5;

/**
 * How many bytes of `_scheduled_functions` docs one `recover` call reads
 * before it stops; `handleRecovery` in loop.ts sends the jobs it didn't reach
 * again on its next pass, a minute later. A completion's args hold return
 * values, up to about 2MB per batch (`MAX_BATCH_SIZE` in complete.ts), so 32
 * of them could pass the transaction read limit. A `recover` that fails that
 * way rolls back, and `handleRecovery` would build the same batch again every
 * minute.
 */
export const RECOVERY_READ_BUDGET = 4_000_000;

/**
 * Before completionId existed, `runMutationWrapper` scheduled `complete`
 * without recording it. That `complete` was created while the wrapper ran,
 * so `findLegacyCompletion` (used only by `recoverLegacyCompletions`) looks
 * for it among scheduled functions created in this window before the
 * wrapper's `completedTime`, checking at most LEGACY_SCAN_LIMIT of them.
 */
const LEGACY_SEARCH_WINDOW_MS = 60_000;
const LEGACY_SCAN_LIMIT = 500;

const recoveryArgs = v.object({
  jobs: v.array(
    v.object({
      scheduledId: v.id("_scheduled_functions"),
      workId: v.id("work"),
      attempt: v.number(),
      started: v.number(),
    }),
  ),
});

/**
 * This can run when things fail because of server failures / restarts, or when
 * the user cancels scheduled jobs (from the dashboard).
 * Possible states it could be in at the moment this executes:
 * - the work committed and scheduled its completion (work.completionId):
 *   -> wait for the completion, or re-run it if it failed.
 * - in internalState.running and complete was never called
 *   -> we should call completeHandler with failure.
 * - complete already called, no action needed (only possible for actions):
 *  - In pendingCompletion still and internalState.running.
 *    -> check for pendingCompletion.
 *  - pendingCompletion already processed.
 *   - No retry: work was deleted, not in internalState.running.
 *     -> check for work.
 *   - Retry: attempts will mismatch
 *     -> check work.attempts
 */
export const recover = internalMutation({
  args: recoveryArgs,
  handler: recoveryHandler,
});

// only exported for testing
export async function recoveryHandler(
  ctx: MutationCtx,
  { jobs }: Infer<typeof recoveryArgs>,
) {
  const globals = await ctx.db.query("globals").unique();
  const console = createLogger(globals?.logLevel);
  const completionJobs: CompleteJob[] = [];
  let freed = false;
  const reads: Reads = { bytes: 0, docs: new Map() };
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    if (i > 0 && reads.bytes >= RECOVERY_READ_BUDGET) {
      // Stopping here, not scheduling another recover, keeps one recover
      // per batch: `handleRecovery` sends these jobs again in a minute.
      console.warn(
        `[recovery] read ${reads.bytes} bytes; leaving ${jobs.length - i}` +
          ` jobs for the next recovery pass`,
      );
      break;
    }
    const preamble = `[recovery] Scheduled job ${job.scheduledId} for work ${job.workId}`;
    const pendingCompletion = await ctx.db
      .query("pendingCompletion")
      .withIndex("workId", (q) => q.eq("workId", job.workId))
      .first();
    if (pendingCompletion) {
      // Completion already pending, no need to do anything.
      console.debug(`${preamble} already in pendingCompletion, skipping`);
      continue;
    }
    const work = await ctx.db.get("work", job.workId);
    if (work === null) {
      // Completion already executed w/o retries, no need to do anything.
      console.warn(`${preamble} work not found, skipping`);
      continue;
    }
    if (work.attempts !== job.attempt) {
      // Retry already started, no need to do anything.
      console.warn(`${preamble} attempts mismatch, skipping`);
      continue;
    }
    if (work.completionId) {
      // The work already committed and scheduled its completion. Check the
      // completion, never the work: re-running committed work isn't safe.
      const lost = await recoverCompletion(
        ctx,
        console,
        reads,
        work,
        work.completionId,
        preamble,
      );
      if (lost) {
        freed = true;
      }
      continue;
    }
    const scheduled = await readScheduled(ctx, reads, job.scheduledId);
    if (scheduled === null) {
      console.warn(`${preamble} not found in _scheduled_functions`);
      completionJobs.push({
        workId: job.workId,
        runResult: { kind: "failed", error: `Scheduled job not found` },
        attempt: job.attempt,
      });
      continue;
    }
    // This will find everything that timed out, failed ungracefully, was
    // canceled, or succeeded without a return value.
    switch (scheduled.state.kind) {
      case "failed": {
        console.debug(`${preamble} failed and detected in recovery`);
        completionJobs.push({
          workId: job.workId,
          runResult: scheduled.state,
          attempt: job.attempt,
        });
        break;
      }
      case "canceled": {
        console.debug(`${preamble} was canceled and detected in recovery`);
        completionJobs.push({
          workId: job.workId,
          runResult: { kind: "failed", error: "Canceled via scheduler" },
          attempt: job.attempt,
        });
        break;
      }
    }
  }
  if (freed) {
    await kickMainLoop(ctx, "complete");
  }
  if (completionJobs.length > 0) {
    await completeHandler(ctx, { jobs: completionJobs });
  }
}

const legacyResult = v.object({
  /** Stuck jobs whose `complete` was found and re-run or is still pending. */
  recovered: v.number(),
  /** Stuck jobs whose `complete` record is gone; their slots were freed. */
  freed: v.number(),
  /** Jobs left as they were, with the reason, e.g. "tooRecent". */
  skipped: v.array(v.object({ workId: v.id("work"), reason: v.string() })),
});

/**
 * One-off repair for pools stuck by #276 before completionId existed: a
 * mutation's `runMutationWrapper` succeeded, but the `complete` it scheduled
 * failed, so the job holds its slot and `recover` skips it. Run it once after
 * upgrading:
 *
 *   npx convex run --component workpool recovery:recoverLegacyCompletions
 *
 * It lists the stuck jobs with `legacyCandidates`, a query, so it doesn't
 * conflict with the main loop's writes to internalState. Then it calls
 * `recoverLegacy` on them in batches, one after another, never more than one
 * at a time. Jobs reported as "tooRecent" can be retried by running it again
 * a few minutes later.
 */
export const recoverLegacyCompletions = internalAction({
  args: {},
  returns: legacyResult,
  handler: async (ctx): Promise<Infer<typeof legacyResult>> => {
    const jobs = await ctx.runQuery(internal.recovery.legacyCandidates, {});
    const total: Infer<typeof legacyResult> = {
      recovered: 0,
      freed: 0,
      skipped: [],
    };
    let i = 0;
    while (i < jobs.length) {
      const result = await ctx.runMutation(internal.recovery.recoverLegacy, {
        jobs: jobs.slice(i, i + RECOVERY_BATCH_SIZE),
      });
      // recoverLegacy always handles at least the first job it's given.
      i += result.processed;
      total.recovered += result.recovered;
      total.freed += result.freed;
      total.skipped.push(...result.skipped);
    }
    return total;
  },
});

/**
 * Running jobs older than RECOVERY_THRESHOLD_MS with no completionId: the
 * ones `recoverLegacy` may be able to repair.
 */
export const legacyCandidates = internalQuery({
  args: {},
  returns: recoveryArgs.fields.jobs,
  handler: async (ctx) => {
    const state = await ctx.db.query("internalState").unique();
    const oldEnough = Date.now() - RECOVERY_THRESHOLD_MS;
    const jobs = [];
    for (const r of state?.running ?? []) {
      if (r.started >= oldEnough || r.completing) {
        continue;
      }
      const work = await ctx.db.get("work", r.workId);
      if (work && !work.completionId) {
        const { workId, scheduledId, started } = r;
        jobs.push({ workId, scheduledId, started, attempt: work.attempts });
      }
    }
    return jobs;
  },
});

export const recoverLegacy = internalMutation({
  args: recoveryArgs,
  returns: v.object({ ...legacyResult.fields, processed: v.number() }),
  handler: async (ctx, { jobs }) => {
    const globals = await ctx.db.query("globals").unique();
    const console = createLogger(globals?.logLevel);
    const reads: Reads = { bytes: 0, docs: new Map() };
    const result = {
      recovered: 0,
      freed: 0,
      skipped: [] as { workId: Id<"work">; reason: string }[],
      processed: 0,
    };
    for (const job of jobs) {
      const preamble = `[recoverLegacy] Scheduled job ${job.scheduledId} for work ${job.workId}`;
      const skip = (reason: string) => {
        console.info(`${preamble}: skipping, ${reason}`);
        result.skipped.push({ workId: job.workId, reason });
      };
      if (result.processed > 0 && reads.bytes >= RECOVERY_READ_BUDGET) {
        break;
      }
      const work = await ctx.db.get("work", job.workId);
      const pendingCompletion = await ctx.db
        .query("pendingCompletion")
        .withIndex("workId", (q) => q.eq("workId", job.workId))
        .first();
      const scheduled =
        work && !work.completionId && work.attempts === job.attempt
          ? await readScheduled(ctx, reads, job.scheduledId)
          : null;
      if (!work || pendingCompletion || !scheduled) {
        result.processed++;
        skip("already finished, completing or retried");
        continue;
      }
      // Only a mutation or query wrapper schedules its own completion; an
      // action's completion is handled by `completeInline` in worker.ts.
      // A failed or canceled wrapper is handled by `recover`.
      if (
        scheduled.state.kind !== "success" ||
        !scheduled.name.endsWith("runMutationWrapper")
      ) {
        result.processed++;
        skip(`not a succeeded mutation wrapper (${scheduled.state.kind})`);
        continue;
      }
      const legacy = await findLegacyCompletion(ctx, reads, scheduled, job);
      if (legacy === "overBudget" && result.processed > 0) {
        // Leave this job for the next batch, which starts with nothing read.
        break;
      }
      result.processed++;
      if (
        legacy === "tooRecent" ||
        legacy === "truncated" ||
        legacy === "overBudget"
      ) {
        skip(legacy);
        continue;
      }
      if (legacy === null) {
        console.error(
          `${preamble} succeeded but its completion is gone; freeing its slot`,
        );
        await giveUp(ctx, work._id, "Completion failed: not found");
        result.freed++;
        continue;
      }
      console.warn(`${preamble} tracking its lost completion ${legacy}`);
      await ctx.db.patch("work", work._id, { completionId: legacy });
      const lost = await recoverCompletion(
        ctx,
        console,
        reads,
        work,
        legacy,
        preamble,
      );
      if (lost) {
        result.freed++;
      } else {
        result.recovered++;
      }
    }
    if (result.freed > 0) {
      await kickMainLoop(ctx, "complete");
    }
    return result;
  },
});

/**
 * Handle work whose completion was scheduled. A pending completion may just
 * be behind a scheduler backlog, so it's left alone. A failed or canceled one
 * is re-run from its stored args: `complete` is guarded by the attempt
 * number, so running it again is safe. Returns true if it gave up and freed
 * the slot directly.
 */
async function recoverCompletion(
  ctx: MutationCtx,
  console: Logger,
  reads: Reads,
  work: Doc<"work">,
  completionId: Id<"_scheduled_functions">,
  preamble: string,
): Promise<boolean> {
  const completion = await readScheduled(ctx, reads, completionId);
  const state = completion?.state.kind;
  if (state === "pending" || state === "inProgress") {
    console.debug(`${preamble} completion ${completionId} is ${state}`);
    return false;
  }
  const reruns = work.completionReruns ?? 0;
  const job = (
    completion?.args[0] as { jobs?: CompleteJob[] } | undefined
  )?.jobs?.find((j) => j.workId === work._id && j.attempt === work.attempts);
  const error =
    completion?.state.kind === "failed" ? completion.state.error : state;
  if (job && reruns < MAX_COMPLETION_RERUNS) {
    console.warn(
      `${preamble} completion ${completionId} ${state ?? "not found"}` +
        ` (${error}), re-running (${reruns + 1}/${MAX_COMPLETION_RERUNS})`,
    );
    const rerunId = await ctx.scheduler.runAfter(
      0,
      internal.complete.complete,
      { jobs: [job] },
    );
    await ctx.db.patch("work", work._id, {
      completionId: rerunId,
      completionReruns: reruns + 1,
    });
    return false;
  }
  // The result is gone (the scheduler record was cleaned up) or completing
  // keeps failing. Free the slot so the pool keeps moving, but leave the
  // work in place: its onComplete hasn't run.
  // TODO: dead letter queue, and a status for work stuck here.
  console.error(
    `${preamble} giving up on completion ${completionId} after ${reruns}` +
      ` re-runs (${completion ? error : "not found"}); freeing its slot`,
  );
  await giveUp(
    ctx,
    work._id,
    `Completion failed: ${completion ? error : "not found"}`,
  );
  return true;
}

/**
 * Frees the work's slot without running its onComplete: the main loop
 * removes it from `running` when it handles this pendingCompletion, and the
 * work doc stays in place.
 */
async function giveUp(ctx: MutationCtx, workId: Id<"work">, error: string) {
  await ctx.db.insert("pendingCompletion", {
    segment: ctx.db.vars.commitTs,
    workId,
    runResult: { kind: "failed", error },
    retry: false,
  });
}

type ScheduledDoc = SystemDataModel["_scheduled_functions"]["document"];

/** Scheduled function docs this `recover` call has read, and their size. */
export type Reads = {
  bytes: number;
  docs: Map<Id<"_scheduled_functions">, ScheduledDoc | null>;
};

/**
 * Reads a scheduled function once per `recover` call, adding its size to
 * `reads.bytes`. Several works in a split batch share one completion doc.
 */
async function readScheduled(
  ctx: MutationCtx,
  reads: Reads,
  id: Id<"_scheduled_functions">,
) {
  if (reads.docs.has(id)) {
    return reads.docs.get(id)!;
  }
  const doc = await ctx.db.system.get("_scheduled_functions", id);
  reads.docs.set(id, doc);
  if (doc) {
    reads.bytes += getConvexSize(doc);
  }
  return doc;
}

/**
 * Finds the `complete` a pre-completionId `runMutationWrapper` scheduled for
 * this attempt. Returns its id, or null if it's not in the search window (the
 * scheduler deletes finished records after a while). Returns "truncated"
 * after checking LEGACY_SCAN_LIMIT records without a match, and "overBudget"
 * once `reads.bytes` reaches RECOVERY_READ_BUDGET; in both cases the answer
 * isn't known. Returns "tooRecent", reading nothing, if the window ends less
 * than RECOVERY_THRESHOLD_MS ago: the scheduler keeps inserting and updating
 * recent `_scheduled_functions` records, so reading them would make this
 * mutation conflict with it.
 */
// only exported for testing
export async function findLegacyCompletion(
  ctx: MutationCtx,
  reads: Reads,
  wrapper: ScheduledDoc,
  job: { workId: Id<"work">; attempt: number },
): Promise<
  Id<"_scheduled_functions"> | null | "tooRecent" | "truncated" | "overBudget"
> {
  // `complete` was created while the wrapper ran: after its scheduledTime
  // and just before its completedTime, which is set as it commits. So the
  // search reads newest first from completedTime, plus a second for clock
  // differences, and usually matches within the first few records. When
  // completedTime isn't recorded, it reads forward from scheduledTime.
  const completedTime = wrapper.completedTime;
  const start =
    completedTime === undefined
      ? wrapper.scheduledTime
      : Math.max(
          wrapper.scheduledTime,
          completedTime - LEGACY_SEARCH_WINDOW_MS,
        );
  const end =
    (completedTime ?? wrapper.scheduledTime + LEGACY_SEARCH_WINDOW_MS) + 1000;
  if (end > Date.now() - RECOVERY_THRESHOLD_MS) {
    return "tooRecent";
  }
  const candidates = ctx.db.system
    .query("_scheduled_functions")
    .withIndex("by_creation_time", (q) =>
      q.gte("_creationTime", start).lte("_creationTime", end),
    )
    .order(completedTime === undefined ? "asc" : "desc");
  // Iterating fetches records as the loop reaches them, so each one read is
  // counted in reads.bytes before the next is fetched.
  let checked = 0;
  for await (const candidate of candidates) {
    reads.bytes += getConvexSize(candidate);
    checked++;
    const jobs = candidate.name.endsWith("complete")
      ? (candidate.args[0] as { jobs?: CompleteJob[] } | undefined)?.jobs
      : undefined;
    if (
      jobs?.some((j) => j.workId === job.workId && j.attempt === job.attempt)
    ) {
      reads.docs.set(candidate._id, candidate);
      return candidate._id;
    }
    if (reads.bytes >= RECOVERY_READ_BUDGET) {
      return "overBudget";
    }
    if (checked >= LEGACY_SCAN_LIMIT) {
      return "truncated";
    }
  }
  return null;
}
