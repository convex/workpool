import type { FunctionHandle } from "convex/server";
import { getConvexSize, type Infer, v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel.js";
import { internal } from "./_generated/api.js";
import { internalMutation, type MutationCtx } from "./_generated/server.js";
import { kickMainLoop } from "./kick.js";
import { createLogger } from "./logging.js";
import {
  countedAttempts,
  type OnCompleteArgs,
  type RunResult,
  vResult,
} from "./shared.js";
import { layoutPayload } from "./payload.js";
import { recordCompleted } from "./stats.js";
import { assert } from "convex-helpers";

export type CompleteJob = Infer<typeof completeArgs.fields.jobs.element>;

const completeArgs = v.object({
  jobs: v.array(
    v.object({
      runResult: vResult,
      workId: v.id("work"),
      attempt: v.number(),
      nonRetryable: v.optional(v.boolean()),
      // The job threw RescheduleError: run it again without using an attempt.
      reschedule: v.optional(v.object({ delayMs: v.number() })),
      // The job returned continueWith: run it again with these args.
      continueWith: v.optional(
        v.object({
          args: v.record(v.string(), v.any()),
          delayMs: v.number(),
        }),
      ),
      // TODO: need to be careful about removing this field later
      runOnCompleteInline: v.optional(v.boolean()),
    }),
  ),
});
export async function completeHandler(
  ctx: MutationCtx,
  args: Infer<typeof completeArgs>,
) {
  const globals = await ctx.db.query("globals").unique();
  const console = createLogger(globals?.logLevel);
  if (args.jobs.length === 0) {
    console.warn("Trying to complete 0 jobs");
    return;
  }
  const pendingCompletions: {
    runResult: RunResult;
    workId: Id<"work">;
    retry: boolean;
    rescheduleDelayMs?: number;
  }[] = [];
  const jobAndWorks = (
    await Promise.all(
      args.jobs.map(async (job) => {
        const work = await ctx.db.get("work", job.workId);
        if (!work) {
          console.warn(
            `[complete] ${job.workId} is done, but its work is gone`,
          );
          return null;
        }
        if (work.attempts !== job.attempt) {
          console.warn(`[complete] ${job.workId} mismatched attempt number`);
          return null;
        }
        return { job, work };
      }),
    )
  ).filter((a) => a !== null);
  if (jobAndWorks.length === 0) {
    return;
  }
  const MAX_BATCH_SIZE = 2_000_000; // combined job / work / payload size

  // Create batches based on size
  const batches: (typeof jobAndWorks)[] = [];
  let currentBatch: typeof jobAndWorks = [];
  let currentBatchSize = 0;

  for (const item of jobAndWorks) {
    const itemSize =
      getConvexSize(item.job) +
      getConvexSize(item.work) +
      (item.work.payloadSize ?? 0);

    // If adding this item would exceed the limit, start a new batch
    if (
      currentBatch.length > 0 &&
      currentBatchSize + itemSize > MAX_BATCH_SIZE
    ) {
      batches.push(currentBatch);
      currentBatch = [];
      currentBatchSize = 0;
    }

    currentBatch.push(item);
    currentBatchSize += itemSize;
  }

  // Add the last batch if it has items
  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  // Schedule all batches after the first one
  for (let i = 1; i < batches.length; i++) {
    await ctx.scheduler.runAfter(0, internal.complete.complete, {
      jobs: batches[i]!.map(({ job }) => job),
    });
  }

  const ourBatch = batches[0];
  assert(ourBatch);

  await Promise.all(
    ourBatch.map(async ({ work, job }) => {
      // attempts always increments: it's how we ignore duplicate completions.
      work.attempts++;
      if (job.reschedule) {
        work.skippedAttempts = (work.skippedAttempts ?? 0) + 1;
      }
      await ctx.db.patch("work", work._id, {
        attempts: work.attempts,
        skippedAttempts: work.skippedAttempts,
      });
      const pendingCompletion = await ctx.db
        .query("pendingCompletion")
        .withIndex("workId", (q) => q.eq("workId", job.workId))
        .unique();
      if (pendingCompletion) {
        console.warn(`[complete] ${job.workId} already in pendingCompletion`);
        return;
      }
      if (job.continueWith) {
        try {
          await continueWithArgs(ctx, work, job.continueWith.args);
        } catch (e) {
          // The next step can't be stored, so the job fails here.
          console.error(`[complete] ${job.workId} can't continue: ${e}`);
          job.runResult = {
            kind: "failed",
            error: `Couldn't continue with new args: ${e instanceof Error ? e.message : String(e)}`,
          };
          job.nonRetryable = true;
          delete job.continueWith;
        }
      }
      const reschedule = job.reschedule ?? job.continueWith;
      const maxAttempts = work.retryBehavior?.maxAttempts;
      const retry =
        !!reschedule ||
        (job.runResult.kind === "failed" &&
          !job.nonRetryable &&
          !!maxAttempts &&
          countedAttempts(work) < maxAttempts);
      if (!retry) {
        let scheduledId = undefined;
        if (
          work.onComplete &&
          !work.onComplete.excludeKinds?.includes(job.runResult.kind)
        ) {
          try {
            // Retrieve large context if stored separately
            let context = work.onComplete.context;
            if (context === undefined && work.payloadId) {
              const payload = await ctx.db.get("payload", work.payloadId);
              if (payload) {
                context = payload.context;
              }
            }

            const handle = work.onComplete.fnHandle as FunctionHandle<
              "mutation",
              OnCompleteArgs,
              void
            >;
            const onCompleteArgs = {
              workId: work._id,
              context,
              result: job.runResult,
            };
            if (job.runOnCompleteInline) {
              try {
                await ctx.runMutation(handle, onCompleteArgs);
              } catch (e) {
                console.error(
                  `[complete] caught error while running onComplete inline for ${job.workId}, scheduling instead: ${e}`,
                );
                scheduledId = await ctx.scheduler.runAfter(
                  0,
                  handle,
                  onCompleteArgs,
                );
              }
            } else {
              scheduledId = await ctx.scheduler.runAfter(
                0,
                handle,
                onCompleteArgs,
              );
              console.debug(
                `[complete] onComplete for ${job.workId} scheduled`,
              );
            }
          } catch (e) {
            console.error(
              `[complete] error running onComplete for ${job.workId}`,
              e,
            );
            // TODO: store failures in a table for later debugging
          }
        }
        recordCompleted(console, work, job.runResult.kind, scheduledId);

        // Clean up any large data that was stored separately. Deleting a
        // nonexistent doc throws; this cleanup must not fail the completion.
        if (work.payloadId) {
          try {
            await ctx.db.delete("payload", work.payloadId);
          } catch (e) {
            console.warn(
              `[complete] couldn't delete payload for ${job.workId}: ${e}`,
            );
          }
        }

        // This is the terminating state for work.
        await ctx.db.delete("work", job.workId);
      }
      if (job.runResult.kind !== "canceled") {
        pendingCompletions.push({
          runResult: stripResult(job.runResult),
          workId: job.workId,
          retry,
          ...(reschedule ? { rescheduleDelayMs: reschedule.delayMs } : {}),
        });
      }
    }),
  );
  if (pendingCompletions.length > 0) {
    await kickMainLoop(
      ctx,
      pendingCompletions.some((completion) => completion.retry)
        ? "retry"
        : "complete",
    );
    await Promise.all(
      pendingCompletions.map((completion) =>
        ctx.db.insert("pendingCompletion", {
          ...completion,
          segment: ctx.db.vars.commitTs,
        }),
      ),
    );
  }
}

/**
 * Stores the args for a job's next step, and starts its retry budget over.
 * Throws if the args are too large to store.
 */
async function continueWithArgs(
  ctx: MutationCtx,
  work: Doc<"work">,
  args: Record<string, unknown>,
) {
  let context = work.onComplete?.context;
  if (context === undefined && work.payloadId) {
    context = (await ctx.db.get("payload", work.payloadId))?.context;
  }
  const layout = layoutPayload(work.fnName, args, context);
  if (work.payloadId) {
    await ctx.db.delete("payload", work.payloadId);
  }
  let onComplete = work.onComplete;
  if (onComplete) {
    const { context: _, ...rest } = onComplete;
    onComplete =
      layout.context === undefined
        ? rest
        : { ...rest, context: layout.context };
  }
  await ctx.db.patch("work", work._id, {
    fnArgs: layout.fnArgs,
    onComplete,
    payloadId: layout.payload
      ? await ctx.db.insert("payload", layout.payload)
      : undefined,
    payloadSize: layout.payload ? layout.payloadSize : undefined,
    // Each step gets the full retry budget.
    skippedAttempts: work.attempts,
  });
}

function stripResult(result: RunResult): RunResult {
  if (result.kind === "success") {
    return { kind: "success", returnValue: null };
  }
  return result;
}

export const complete = internalMutation({
  args: completeArgs,
  handler: completeHandler,
});
