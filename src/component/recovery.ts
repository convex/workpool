import { type Infer, v } from "convex/values";
import type { Doc } from "./_generated/dataModel.js";
import { internal } from "./_generated/api.js";
import { internalMutation, type MutationCtx } from "./_generated/server.js";
import { createLogger, type Logger } from "./logging.js";
import { type CompleteJob, completeHandler } from "./complete.js";
import { kickMainLoop } from "./kick.js";

// Re-run a failed completion this many times before giving up on it.
export const MAX_COMPLETION_RERUNS = 5;

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
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
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
      const lost = await recoverCompletion(ctx, console, work, preamble);
      if (lost) {
        freed = true;
      }
      continue;
    }
    const scheduled = await ctx.db.system.get(
      "_scheduled_functions",
      job.scheduledId,
    );
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
  work: Doc<"work">,
  preamble: string,
): Promise<boolean> {
  const completionId = work.completionId!;
  const completion = await ctx.db.system.get(
    "_scheduled_functions",
    completionId,
  );
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
  await ctx.db.insert("pendingCompletion", {
    segment: ctx.db.vars.commitTs,
    workId: work._id,
    runResult: {
      kind: "failed",
      error: `Completion failed: ${completion ? error : "not found"}`,
    },
    retry: false,
  });
  return true;
}
