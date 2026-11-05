import { vOnCompleteArgs } from "@convex-dev/workpool";
import { ConvexError, v, type Value } from "convex/values";
import { internal } from "./_generated/api.js";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server.js";

const args = { data: v.any() };
const fail = (_ctx: unknown, { data }: { data: Value }): never => {
  throw new ConvexError(data);
};

export const failingQuery = internalQuery({
  args,
  returns: v.null(),
  handler: fail,
});
export const failingMutation = internalMutation({
  args,
  returns: v.null(),
  handler: fail,
});
export const failingAction = internalAction({
  args,
  returns: v.null(),
  handler: async (ctx, args): Promise<never> => {
    await ctx.runMutation(internal.errorData.recordActionAttempt, {});
    return fail(ctx, args);
  },
});

export const recordActionAttempt = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await ctx.db.insert("data", { misc: { kind: "attempt" } });
    return null;
  },
});

export const onComplete = internalMutation({
  args: vOnCompleteArgs(v.null()),
  returns: v.null(),
  handler: async (ctx, { result }) => {
    await ctx.db.insert("data", { misc: result });
    return null;
  },
});
