import { v } from "convex/values";
import {
  mutation,
  query,
  internalAction,
  internalMutation,
  internalQuery,
  type QueryCtx,
} from "../_generated/server";
import { components, internal } from "../_generated/api";
import {
  RescheduleError,
  vOnCompleteArgs,
  vWorkId,
  WorkId,
  Workpool,
} from "@convex-dev/workpool";

const smallPool = new Workpool(components.smallPool, {
  maxParallelism: 3,
  logLevel: "INFO",
});

const ATTEMPT_EVENT = "rescheduleAttempt";
const COMPLETION_EVENT = "rescheduleCompletion";

function isEvent(
  value: unknown,
  kind: string,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { kind?: unknown }).kind === kind
  );
}

export const recordAttempt = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    await ctx.db.insert("data", { misc: { kind: ATTEMPT_EVENT } });
    const docs = await ctx.db.query("data").collect();
    return docs.filter((doc) => isEvent(doc.misc, ATTEMPT_EVENT)).length;
  },
});

export const recordCompletion = internalMutation({
  args: vOnCompleteArgs(v.null()),
  handler: async (ctx, args) => {
    await ctx.db.insert("data", {
      misc: { kind: COMPLETION_EVENT, result: args.result.kind },
    });
  },
});

/** Reschedules `reschedules` times, then fails `failures` times, then succeeds. */
export const flakyAction = internalAction({
  args: { reschedules: v.number(), failures: v.number(), delayMs: v.number() },
  handler: async (ctx, args) => {
    const attempt: number = await ctx.runMutation(
      internal.test.reschedule.recordAttempt,
      {},
    );
    if (attempt <= args.reschedules) {
      throw new RescheduleError({ delayMs: args.delayMs });
    }
    if (attempt <= args.reschedules + args.failures) {
      throw new Error(`failure on attempt ${attempt}`);
    }
    return null;
  },
});

export const enqueueFlakyAction = mutation({
  args: {
    reschedules: v.number(),
    failures: v.number(),
    delayMs: v.number(),
    maxAttempts: v.optional(v.number()),
  },
  handler: async (ctx, { maxAttempts, ...args }): Promise<WorkId> => {
    return await smallPool.enqueueAction(
      ctx,
      internal.test.reschedule.flakyAction,
      args,
      {
        retry: maxAttempts
          ? { maxAttempts, initialBackoffMs: 100, base: 2 }
          : false,
        onComplete: internal.test.reschedule.recordCompletion,
        context: null,
      },
    );
  },
});

const READY_EVENT = "rescheduleReady";

async function isReady(ctx: { db: QueryCtx["db"] }) {
  const docs = await ctx.db.query("data").collect();
  return docs.some((doc) => isEvent(doc.misc, READY_EVENT));
}

export const markReady = mutation({
  args: {},
  handler: async (ctx) => {
    await ctx.db.insert("data", { misc: { kind: READY_EVENT } });
  },
});

/** Records an attempt, which is rolled back while it reschedules. */
export const waitingMutation = internalMutation({
  args: {},
  handler: async (ctx) => {
    await ctx.db.insert("data", { misc: { kind: ATTEMPT_EVENT } });
    if (!(await isReady(ctx))) {
      throw new RescheduleError({ delayMs: 10_000 });
    }
  },
});

export const enqueueWaitingMutation = mutation({
  args: {},
  handler: async (ctx): Promise<WorkId> => {
    return await smallPool.enqueueMutation(
      ctx,
      internal.test.reschedule.waitingMutation,
      {},
      {
        onComplete: internal.test.reschedule.recordCompletion,
        context: null,
      },
    );
  },
});

export const waitingQuery = internalQuery({
  args: {},
  handler: async (ctx) => {
    if (!(await isReady(ctx))) {
      throw new RescheduleError({ delayMs: 10_000 });
    }
    return null;
  },
});

export const enqueueWaitingQuery = mutation({
  args: {},
  handler: async (ctx): Promise<WorkId> => {
    return await smallPool.enqueueQuery(
      ctx,
      internal.test.reschedule.waitingQuery,
      {},
      {
        onComplete: internal.test.reschedule.recordCompletion,
        context: null,
      },
    );
  },
});

export const cancel = mutation({
  args: { id: vWorkId },
  handler: async (ctx, { id }) => {
    await smallPool.cancel(ctx, id);
  },
});

export const attemptCount = query({
  args: {},
  handler: async (ctx) => {
    const docs = await ctx.db.query("data").collect();
    return docs.filter((doc) => isEvent(doc.misc, ATTEMPT_EVENT)).length;
  },
});

export const completions = query({
  args: {},
  handler: async (ctx) => {
    const docs = await ctx.db.query("data").collect();
    return docs.flatMap((doc) =>
      isEvent(doc.misc, COMPLETION_EVENT) ? [doc.misc.result] : [],
    );
  },
});
