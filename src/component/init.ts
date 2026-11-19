import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import { internalMutation } from "./_generated/server.js";
import { effectiveConfig, validateConfig } from "./config.js";
import { DEFAULT_LOG_LEVEL } from "./logging.js";
import { DEFAULT_MAX_PARALLELISM, initArgs } from "./shared.js";

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
    const before = effectiveConfig(globals).maxParallelism;
    if (!globals) {
      await ctx.db.insert("globals", {
        maxParallelism: DEFAULT_MAX_PARALLELISM,
        logLevel: DEFAULT_LOG_LEVEL,
        init: args,
      });
    } else if (JSON.stringify(globals.init) !== JSON.stringify(args)) {
      await ctx.db.patch("globals", globals._id, { init: args });
    } else {
      return null;
    }
    const after = args.maxParallelism ?? globals?.maxParallelism;
    if (after !== undefined && after > before) {
      // Inits can't call into batch-worker to ping the loop directly.
      await ctx.scheduler.runAfter(0, internal.kick.kick, {});
    }
    return null;
  },
});
