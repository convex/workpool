import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import { internalMutation } from "./_generated/server.js";
import { getCurrentSegment } from "./shared.js";

const BATCH_SIZE = 100;

/**
 * One-off backfill of `work.pendingStartId` for work enqueued before it was
 * recorded. Walks future starts from the latest down to now; the loop records
 * the pointer on the rest as it starts them. Run it with
 * `npx convex run --component workpool migrations:backfillPendingStartIds`.
 */
export const backfillPendingStartIds = internalMutation({
  args: { cursor: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("pendingStart")
      .withIndex("segment")
      .order("desc")
      .paginate({ cursor: args.cursor ?? null, numItems: BATCH_SIZE });
    const now = getCurrentSegment();
    const future = page.page.filter((entry) => entry.segment > now);
    const updated = (
      await Promise.all(
        future.map(async (entry) => {
          const work = await ctx.db.get("work", entry.workId);
          if (!work || work.pendingStartId !== undefined) return false;
          await ctx.db.patch("work", work._id, { pendingStartId: entry._id });
          return true;
        }),
      )
    ).filter(Boolean).length;
    if (page.isDone || future.length < page.page.length) {
      console.log(`Done backfilling. ${updated} updated in the last batch.`);
    } else {
      console.log(`Continuing after updating ${updated}.`);
      await ctx.scheduler.runAfter(
        0,
        internal.migrations.backfillPendingStartIds,
        { cursor: page.continueCursor },
      );
    }
    return null;
  },
});
