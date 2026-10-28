import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import { internalMutation } from "./_generated/server.js";

const BATCH_SIZE = 500;

/**
 * One-off backfill of `work.pendingStartId` for work enqueued before it was
 * recorded, deleting entries whose work is gone. Walks entries created before
 * it started, newest first. Run it with
 * `npx convex run --component workpool migrations:backfillPendingStartIds`.
 */
export const backfillPendingStartIds = internalMutation({
  args: {
    // Fixed for the whole run so the paginated query, and its cursor, match.
    before: v.optional(v.number()),
    cursor: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<void> => {
    const before = args.before;
    if (!before) {
      // Immediately pin the before value, so on OCCs we don't keep moving
      // the target start.
      // Eventually, old transactions will settle and we'll only be looking at
      // older docs.
      await ctx.scheduler.runAfter(
        0,
        internal.migrations.backfillPendingStartIds,
        { before: Date.now() },
      );
      return;
    }
    const page = await ctx.db
      .query("pendingStart")
      .withIndex("by_creation_time", (q) => q.lte("_creationTime", before))
      .order("desc")
      .paginate({ cursor: args.cursor ?? null, numItems: BATCH_SIZE });
    const results = await Promise.all(
      page.page.map(async (entry) => {
        const work = await ctx.db.get("work", entry.workId);
        if (!work) {
          await ctx.db.delete("pendingStart", entry._id);
          return "deleted";
        }
        if (work.pendingStartId !== undefined) return "skipped";
        await ctx.db.patch("work", work._id, { pendingStartId: entry._id });
        return "updated";
      }),
    );
    const updated = results.filter((r) => r === "updated").length;
    const deleted = results.filter((r) => r === "deleted").length;
    if (page.isDone) {
      console.log(
        `Done backfilling. Last batch: ${updated} updated, ${deleted} deleted.`,
      );
    } else {
      console.log(`Continuing after ${updated} updated, ${deleted} deleted.`);
      await ctx.scheduler.runAfter(
        0,
        internal.migrations.backfillPendingStartIds,
        { before, cursor: page.continueCursor },
      );
    }
  },
});
