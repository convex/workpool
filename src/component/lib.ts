import { type ObjectType, v } from "convex/values";
import type { WithoutSystemFields } from "convex/server";
import { api } from "./_generated/api.js";
import { type Doc, type Id } from "./_generated/dataModel.js";
import {
  mutation,
  type MutationCtx,
  query,
  type QueryCtx,
} from "./_generated/server.js";
import { kickMainLoop } from "./kick.js";
import {
  createLogger,
  type Logger,
  type LogLevel,
  logLevel,
} from "./logging.js";
import {
  boundScheduledTime,
  countedAttempts,
  vConfig,
  fnType,
  vOnCompleteFnContext,
  retryBehavior,
  status as statusValidator,
  MINUTE,
  toTimestamp,
} from "./shared.js";
import { recordEnqueued } from "./stats.js";
import { getOrUpdateGlobals } from "./config.js";
import { findPendingStart } from "./pendingStart.js";
import { layoutPayload } from "./payload.js";

const itemArgs = {
  fnHandle: v.string(),
  fnName: v.string(),
  fnArgs: v.any(),
  fnType,
  runAt: v.number(),
  // TODO: annotation?
  onComplete: v.optional(vOnCompleteFnContext),
  retryBehavior: v.optional(retryBehavior),
};
const enqueueArgs = {
  ...itemArgs,
  config: vConfig.partial(),
};
export const enqueue = mutation({
  args: enqueueArgs,
  returns: v.id("work"),
  handler: async (ctx, { config, ...itemArgs }) => {
    const globals = await getOrUpdateGlobals(ctx, config);
    const console = createLogger(globals.logLevel);
    await kickMainLoop(ctx, "enqueue");
    return await enqueueHandler(ctx, console, itemArgs);
  },
});
/** Exported for tests, so they enqueue exactly what the public API writes. */
export async function enqueueHandler(
  ctx: MutationCtx,
  console: Logger,
  { runAt, ...workArgs }: ObjectType<typeof itemArgs>,
) {
  runAt = boundScheduledTime(runAt, console);

  const layout = layoutPayload(
    workArgs.fnName,
    workArgs.fnArgs,
    workArgs.onComplete?.context,
  );
  const workItem: WithoutSystemFields<Doc<"work">> = {
    ...workArgs,
    fnArgs: layout.fnArgs,
    ...(workArgs.onComplete
      ? { onComplete: { ...workArgs.onComplete, context: layout.context } }
      : {}),
    attempts: 0,
  };
  if (workItem.fnArgs === undefined) delete workItem.fnArgs;
  if (workItem.onComplete?.context === undefined) {
    delete workItem.onComplete?.context;
  }
  if (layout.payload) {
    workItem.payloadId = await ctx.db.insert("payload", layout.payload);
    workItem.payloadSize = layout.payloadSize;
  }

  // Store the work item
  const workId = await ctx.db.insert("work", workItem);
  const now = Date.now();
  let pendingStartId: Id<"pendingStart">;
  if (runAt > now) {
    // Scheduled keys stay at or above the snapshot, which bounds the cursor.
    const segment = toTimestamp(runAt);
    pendingStartId = await ctx.db.insert("pendingStart", {
      workId,
      segment,
      // Only near-term starts can commit behind the cursor.
      ...(segment <= toTimestamp(now + 5 * MINUTE)
        ? { scanTs: ctx.db.vars.commitTs }
        : {}),
    });
  } else {
    pendingStartId = await ctx.db.insert("pendingStart", {
      workId,
      segment: ctx.db.vars.commitTs,
    });
  }
  await ctx.db.patch("work", workId, { pendingStartId });
  recordEnqueued(console, { workId, fnName: workArgs.fnName, runAt });
  return workId;
}

export const enqueueBatch = mutation({
  args: {
    items: v.array(v.object(itemArgs)),
    config: vConfig.partial(),
  },
  returns: v.array(v.id("work")),
  handler: async (ctx, { config, items }) => {
    const globals = await getOrUpdateGlobals(ctx, config);
    const console = createLogger(globals.logLevel);
    await kickMainLoop(ctx, "enqueue");
    return Promise.all(items.map((item) => enqueueHandler(ctx, console, item)));
  },
});

export const cancel = mutation({
  args: {
    id: v.id("work"),
    logLevel: v.optional(logLevel),
  },
  handler: async (ctx, { id, logLevel }) => {
    const globals = await getOrUpdateGlobals(ctx, { logLevel });
    const shouldCancel = await shouldCancelWorkItem(ctx, id, globals.logLevel);
    if (shouldCancel) {
      await kickMainLoop(ctx, "cancel");
      await ctx.db.insert("pendingCancelation", {
        workId: id,
        segment: ctx.db.vars.commitTs,
      });
    }
  },
});

const PAGE_SIZE = 64;
export const cancelAll = mutation({
  args: {
    logLevel: v.optional(logLevel),
    before: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { logLevel, before, limit }) => {
    const beforeTime = before ?? Date.now();
    const pageSize = limit ?? PAGE_SIZE;
    const pageOfWork = await ctx.db
      .query("work")
      .withIndex("by_creation_time", (q) => q.lte("_creationTime", beforeTime))
      .order("desc")
      .take(pageSize);
    const globals = await getOrUpdateGlobals(ctx, { logLevel });
    const shouldCancel = await Promise.all(
      pageOfWork.map(async ({ _id }) =>
        shouldCancelWorkItem(ctx, _id, globals.logLevel),
      ),
    );
    if (shouldCancel.some((c) => c)) {
      await kickMainLoop(ctx, "cancel");
    }
    await Promise.all(
      pageOfWork.map(({ _id }, index) => {
        if (shouldCancel[index]) {
          return ctx.db.insert("pendingCancelation", {
            workId: _id,
            segment: ctx.db.vars.commitTs,
          });
        }
      }),
    );
    if (pageOfWork.length === pageSize) {
      await ctx.scheduler.runAfter(0, api.lib.cancelAll, {
        logLevel,
        before: pageOfWork[pageOfWork.length - 1]._creationTime,
        limit: pageSize,
      });
    }
  },
});

export const status = query({
  args: { id: v.id("work") },
  returns: statusValidator,
  handler: statusHandler,
});
// previousAttempts is countedAttempts(work), not work.attempts: attempts
// that threw RescheduleError don't use up the retry budget, so they don't
// show up here either. continueWithArgs in complete.ts sets skippedAttempts
// to work.attempts at each continueWith step, so it starts again at 0 there.
async function statusHandler(ctx: QueryCtx, { id }: { id: Id<"work"> }) {
  const work = await ctx.db.get("work", id);
  if (!work) {
    return { state: "finished" } as const;
  }
  if (work.pendingStartId === undefined) {
    // During migration, legacy work without a queue pointer reports pending,
    // even if already running. This temporary approximation lasts until the
    // work is upgraded, retried, or finished.
    return {
      state: "pending",
      previousAttempts: countedAttempts(work),
    } as const;
  }
  if (await findPendingStart(ctx, work)) {
    return {
      state: "pending",
      previousAttempts: countedAttempts(work),
    } as const;
  }
  const pendingCompletion = await ctx.db
    .query("pendingCompletion")
    .withIndex("workId", (q) => q.eq("workId", id))
    .unique();
  if (pendingCompletion?.retry) {
    return {
      state: "pending",
      previousAttempts: countedAttempts(work),
    } as const;
  }
  // Assume it's in progress. It could be pending cancelation
  return { state: "running", previousAttempts: countedAttempts(work) } as const;
}

export const statusBatch = query({
  args: { ids: v.array(v.id("work")) },
  returns: v.array(statusValidator),
  handler: async (ctx, { ids }) => {
    return await Promise.all(
      ids.map(async (id) => await statusHandler(ctx, { id })),
    );
  },
});

async function shouldCancelWorkItem(
  ctx: MutationCtx,
  workId: Id<"work">,
  logLevel: LogLevel,
) {
  const console = createLogger(logLevel);
  // No-op if the work doesn't exist or has completed.
  const work = await ctx.db.get("work", workId);
  if (!work) {
    console.warn(`[cancel] work ${workId} doesn't exist`);
    return false;
  }
  const pendingCancelation = await ctx.db
    .query("pendingCancelation")
    .withIndex("workId", (q) => q.eq("workId", workId))
    .unique();
  if (pendingCancelation) {
    console.warn(`[cancel] work ${workId} has already been canceled`);
    return false;
  }
  return true;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const console = "THIS IS A REMINDER TO USE createLogger";
