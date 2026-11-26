import { v } from "convex/values";
import {
  mutation,
  query,
  internalAction,
  internalMutation,
  internalQuery,
} from "../_generated/server";
import { components, internal } from "../_generated/api";
import {
  continueWith,
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

const STEP_EVENT = "continueStep";
const COMPLETION_EVENT = "continueCompletion";

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

export const recordCompletion = internalMutation({
  args: vOnCompleteArgs(v.null(), v.number()),
  handler: async (ctx, { result }) => {
    await ctx.db.insert("data", {
      misc: {
        kind: COMPLETION_EVENT,
        result: result.kind,
        ...(result.kind === "success" ? { value: result.returnValue } : {}),
        ...(result.kind === "failed" ? { error: result.error } : {}),
      },
    });
  },
});

/** Records the onComplete context's length, to check it survived. */
export const recordContextCompletion = internalMutation({
  args: vOnCompleteArgs(v.string(), v.number()),
  handler: async (ctx, { context, result }) => {
    await ctx.db.insert("data", {
      misc: {
        kind: COMPLETION_EVENT,
        result: result.kind,
        contextLength: context.length,
        ...(result.kind === "success" ? { value: result.returnValue } : {}),
        ...(result.kind === "failed" ? { error: result.error } : {}),
      },
    });
  },
});

/** Adds up 1..end one number per step, committing each step's write. */
export const sumMutation = internalMutation({
  args: { next: v.number(), end: v.number(), total: v.number() },
  handler: async (ctx, { next, end, total }) => {
    await ctx.db.insert("data", { misc: { kind: STEP_EVENT, step: next } });
    if (next >= end) {
      return total + next;
    }
    return continueWith({ next: next + 1, end, total: total + next });
  },
});

export const enqueueSum = mutation({
  args: { end: v.number() },
  handler: async (ctx, { end }): Promise<WorkId> => {
    return await smallPool.enqueueMutation(
      ctx,
      internal.test.continue.sumMutation,
      { next: 1, end, total: 0 },
      { onComplete: internal.test.continue.recordCompletion, context: null },
    );
  },
});

export const recordStep = internalMutation({
  args: { step: v.number() },
  returns: v.number(),
  handler: async (ctx, { step }) => {
    await ctx.db.insert("data", { misc: { kind: STEP_EVENT, step } });
    const docs = await ctx.db.query("data").collect();
    return docs.filter(
      (doc) => isEvent(doc.misc, STEP_EVENT) && doc.misc.step === step,
    ).length;
  },
});

/**
 * Fails the first attempt of each step, then continues to the next step.
 * `padding` makes the args large enough to be stored separately.
 */
export const stepAction = internalAction({
  args: {
    step: v.number(),
    end: v.number(),
    delayMs: v.number(),
    failFirst: v.boolean(),
    padding: v.string(),
  },
  handler: async (ctx, args) => {
    const tries: number = await ctx.runMutation(
      internal.test.continue.recordStep,
      { step: args.step },
    );
    if (args.failFirst && tries === 1) {
      throw new Error(`step ${args.step} failed`);
    }
    if (args.step >= args.end) {
      return args.step;
    }
    return continueWith(
      { ...args, step: args.step + 1 },
      { delayMs: args.delayMs },
    );
  },
});

export const enqueueSteps = mutation({
  args: {
    end: v.number(),
    delayMs: v.number(),
    failFirst: v.boolean(),
    paddingBytes: v.optional(v.number()),
    // Passes a string context this long, recorded by recordContextCompletion.
    contextBytes: v.optional(v.number()),
    maxAttempts: v.optional(v.number()),
  },
  handler: async (
    ctx,
    { maxAttempts, paddingBytes, contextBytes, ...args },
  ): Promise<WorkId> => {
    const fnArgs = { ...args, step: 1, padding: "x".repeat(paddingBytes ?? 0) };
    const retry = maxAttempts
      ? { maxAttempts, initialBackoffMs: 100, base: 2 }
      : false;
    if (contextBytes !== undefined) {
      return await smallPool.enqueueAction(
        ctx,
        internal.test.continue.stepAction,
        fnArgs,
        {
          retry,
          onComplete: internal.test.continue.recordContextCompletion,
          context: "c".repeat(contextBytes),
        },
      );
    }
    return await smallPool.enqueueAction(
      ctx,
      internal.test.continue.stepAction,
      fnArgs,
      {
        retry,
        onComplete: internal.test.continue.recordCompletion,
        context: null,
      },
    );
  },
});

/**
 * Continues with 600 KB args. Its 600 KB onComplete context fits alone, but
 * not in one payload document with the args.
 */
export const oversizedWithContextAction = internalAction({
  args: { padding: v.optional(v.string()) },
  handler: async (_ctx, { padding }) => {
    if (padding) return 0;
    return continueWith({ padding: "x".repeat(600_000) });
  },
});

export const enqueueOversizedWithContext = mutation({
  args: {},
  handler: async (ctx): Promise<WorkId> => {
    return await smallPool.enqueueAction(
      ctx,
      internal.test.continue.oversizedWithContextAction,
      {},
      {
        onComplete: internal.test.continue.recordContextCompletion,
        context: "c".repeat(600_000),
      },
    );
  },
});

const SELF_CANCEL_EVENT = "continueSelfCancel";

/** Cancels the job whose id enqueueSelfCanceling stored. */
export const cancelStoredJob = internalMutation({
  args: {},
  handler: async (ctx) => {
    const docs = await ctx.db.query("data").collect();
    const doc = docs.find((d) => isEvent(d.misc, SELF_CANCEL_EVENT));
    if (doc) await smallPool.cancel(ctx, doc.misc.id as WorkId);
  },
});

/** Cancels its own job mid-step, then asks for another step. */
export const selfCancelingAction = internalAction({
  args: { step: v.number() },
  handler: async (ctx, { step }) => {
    await ctx.runMutation(internal.test.continue.recordStep, { step });
    await ctx.runMutation(internal.test.continue.cancelStoredJob, {});
    return continueWith({ step: step + 1 });
  },
});

export const enqueueSelfCanceling = mutation({
  args: {},
  handler: async (ctx): Promise<WorkId> => {
    const id = await smallPool.enqueueAction(
      ctx,
      internal.test.continue.selfCancelingAction,
      { step: 1 },
      { onComplete: internal.test.continue.recordCompletion, context: null },
    );
    await ctx.db.insert("data", { misc: { kind: SELF_CANCEL_EVENT, id } });
    return id;
  },
});

/** Counts up to 3 one step at a time; queries can continue too. */
export const countQuery = internalQuery({
  args: { n: v.number() },
  handler: async (_ctx, { n }) => (n >= 3 ? n : continueWith({ n: n + 1 })),
});

export const enqueueCountQuery = mutation({
  args: {},
  handler: async (ctx): Promise<WorkId> => {
    return await smallPool.enqueueQuery(
      ctx,
      internal.test.continue.countQuery,
      { n: 1 },
      { onComplete: internal.test.continue.recordCompletion, context: null },
    );
  },
});

/** Reschedules the first try of each step, then continues to step 2. */
export const mixedAction = internalAction({
  args: { step: v.number() },
  handler: async (ctx, { step }) => {
    const tries: number = await ctx.runMutation(
      internal.test.continue.recordStep,
      { step },
    );
    if (tries === 1) {
      throw new RescheduleError({ delayMs: 1_000 });
    }
    if (step >= 2) return step;
    return continueWith({ step: step + 1 });
  },
});

export const enqueueMixed = mutation({
  args: { maxAttempts: v.number() },
  handler: async (ctx, { maxAttempts }): Promise<WorkId> => {
    return await smallPool.enqueueAction(
      ctx,
      internal.test.continue.mixedAction,
      { step: 1 },
      {
        retry: { maxAttempts, initialBackoffMs: 100, base: 2 },
        onComplete: internal.test.continue.recordCompletion,
        context: null,
      },
    );
  },
});

/**
 * Returns a hand-built continueWith marker without usable args: none, or an
 * ArrayBuffer, which is an object but not one complete's `v.record` accepts.
 */
export const badMarkerAction = internalAction({
  args: { bytesArgs: v.boolean() },
  handler: async (_ctx, { bytesArgs }) =>
    ({
      __convexWorkpoolContinue: true,
      ...(bytesArgs ? { args: new ArrayBuffer(8) } : {}),
      delayMs: 0,
    }) as unknown as number,
});

export const enqueueBadMarker = mutation({
  args: { bytesArgs: v.boolean() },
  handler: async (ctx, { bytesArgs }): Promise<WorkId> => {
    return await smallPool.enqueueAction(
      ctx,
      internal.test.continue.badMarkerAction,
      { bytesArgs },
      {
        retry: { maxAttempts: 3, initialBackoffMs: 100, base: 2 },
        onComplete: internal.test.continue.recordCompletion,
        context: null,
      },
    );
  },
});

/** Continues with args too large to store. */
export const oversizedAction = internalAction({
  args: { padding: v.optional(v.string()) },
  handler: async (_ctx, { padding }) => {
    if (padding) return 0;
    return continueWith({ padding: "x".repeat(1_100_000) });
  },
});

export const enqueueOversized = mutation({
  args: {},
  handler: async (ctx): Promise<WorkId> => {
    return await smallPool.enqueueAction(
      ctx,
      internal.test.continue.oversizedAction,
      {},
      { onComplete: internal.test.continue.recordCompletion, context: null },
    );
  },
});

export const cancel = mutation({
  args: { id: vWorkId },
  handler: async (ctx, { id }) => {
    await smallPool.cancel(ctx, id);
  },
});

export const steps = query({
  args: {},
  handler: async (ctx) => {
    const docs = await ctx.db.query("data").collect();
    return docs.flatMap((doc) =>
      isEvent(doc.misc, STEP_EVENT) ? [doc.misc.step] : [],
    );
  },
});

export const completions = query({
  args: {},
  handler: async (ctx) => {
    const docs = await ctx.db.query("data").collect();
    return docs.flatMap((doc) => {
      if (!isEvent(doc.misc, COMPLETION_EVENT)) return [];
      const { kind: _, ...rest } = doc.misc;
      return [rest];
    });
  },
});
