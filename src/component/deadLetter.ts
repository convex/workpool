/**
 * Work whose completion failed waits here, with its slot freed and its
 * onComplete not run. Recovery puts it here instead of retrying it. Run these
 * from the dashboard: retry runs the completion again from the result the
 * scheduler stored, and discard deletes the work without running onComplete.
 */
import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server.js";
import type { MutationCtx } from "./_generated/server.js";
import type { Doc } from "./_generated/dataModel.js";
import { type CompleteJob, completeHandler } from "./complete.js";

export const list = internalQuery({
  args: { limit: v.optional(v.number()) },
  returns: v.array(
    v.object({
      id: v.id("deadLetter"),
      workId: v.id("work"),
      fnName: v.optional(v.string()),
      attempt: v.number(),
      error: v.string(),
      deadLetteredAt: v.number(),
      resultAvailable: v.boolean(),
    }),
  ),
  handler: async (ctx, { limit }) => {
    const letters = await ctx.db.query("deadLetter").take(limit ?? 100);
    return Promise.all(
      letters.map(async (letter) => {
        const work = await ctx.db.get("work", letter.workId);
        const completion = letter.completionId
          ? await ctx.db.system.get("_scheduled_functions", letter.completionId)
          : null;
        return {
          id: letter._id,
          workId: letter.workId,
          fnName: work?.fnName,
          attempt: letter.attempt,
          error: letter.error,
          deadLetteredAt: letter._creationTime,
          resultAvailable: !!completion && !!findJob(completion, letter),
        };
      }),
    );
  },
});

/**
 * Runs the work's completion again, in this transaction: if it fails, the
 * dead letter stays. Its onComplete runs, or the work is retried if its
 * result calls for it. Throws if the scheduler no longer has the result.
 */
export const retry = internalMutation({
  args: { id: v.id("deadLetter") },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    const letter = await ctx.db.get("deadLetter", id);
    if (!letter) {
      throw new Error(`Dead letter ${id} not found`);
    }
    const work = await currentWork(ctx, letter);
    await ctx.db.delete("deadLetter", id);
    if (!work) return null;
    const completion = letter.completionId
      ? await ctx.db.system.get("_scheduled_functions", letter.completionId)
      : null;
    const job = completion && findJob(completion, letter);
    if (!job) {
      throw new Error(
        `The result for work ${work._id} is no longer available; discard it instead`,
      );
    }
    await completeHandler(ctx, { jobs: [job] });
    // The work holds no slot, so the main loop only needs to hear about a
    // retry.
    const pendingCompletion = await ctx.db
      .query("pendingCompletion")
      .withIndex("workId", (q) => q.eq("workId", work._id))
      .unique();
    if (pendingCompletion && !pendingCompletion.retry) {
      await ctx.db.delete("pendingCompletion", pendingCompletion._id);
    }
    return null;
  },
});

/** Deletes the work without running its onComplete. */
export const discard = internalMutation({
  args: { id: v.id("deadLetter") },
  returns: v.null(),
  handler: async (ctx, { id }) => {
    const letter = await ctx.db.get("deadLetter", id);
    if (!letter) return null;
    await ctx.db.delete("deadLetter", id);
    const work = await currentWork(ctx, letter);
    if (!work) return null;
    if (work.payloadId && (await ctx.db.get("payload", work.payloadId))) {
      await ctx.db.delete("payload", work.payloadId);
    }
    await ctx.db.delete("work", work._id);
    return null;
  },
});

/** The dead-lettered work, unless it has since moved on. */
async function currentWork(ctx: MutationCtx, letter: Doc<"deadLetter">) {
  const work = await ctx.db.get("work", letter.workId);
  return work?.attempts === letter.attempt ? work : null;
}

function findJob(
  completion: { args: unknown[] },
  letter: Doc<"deadLetter">,
): CompleteJob | undefined {
  const args = completion.args[0] as { jobs?: CompleteJob[] } | undefined;
  return args?.jobs?.find(
    (j) => j.workId === letter.workId && j.attempt === letter.attempt,
  );
}
