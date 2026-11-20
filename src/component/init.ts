import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import { internalMutation } from "./_generated/server.js";
import { effectiveConfig, validateConfig } from "./config.js";
import { initArgs } from "./shared.js";

/**
 * Runs in every push's transaction, so it must stay within the init limits
 * (100 documents read/written, 10 scheduled functions, no runQuery/runMutation)
 * and should write nothing when the args are unchanged.
 */
export const init = internalMutation({
  args: initArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    validateConfig(args);
    const globals = await ctx.db.query("globals").unique();
    const next = { ...args, overrides: globals?.overrides };
    if (!globals) {
      await ctx.db.insert("globals", next);
    } else if (
      globals.maxParallelism !== args.maxParallelism ||
      globals.logLevel !== args.logLevel
    ) {
      // `replace` drops args the parent stopped passing; overrides carry over.
      await ctx.db.replace("globals", globals._id, next);
    } else {
      return null;
    }
    const before = effectiveConfig(globals).maxParallelism;
    if (effectiveConfig(next).maxParallelism > before) {
      // Inits can't call into batch-worker to ping the loop directly.
      await ctx.scheduler.runAfter(0, internal.kick.kick, {});
    }
    return null;
  },
});
