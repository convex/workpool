import type { Doc } from "./_generated/dataModel.js";
import { mutation, type QueryCtx } from "./_generated/server.js";
import { DEFAULT_MAX_PARALLELISM, vConfig, type Config } from "./shared.js";
import { createLogger, DEFAULT_LOG_LEVEL } from "./logging.js";
import { kickMainLoop } from "./kick.js";

export const MAX_POSSIBLE_PARALLELISM = 200;
export const MAX_PARALLELISM_SOFT_LIMIT = 100;

/**
 * The globals document holds the init args, plus the runtime overrides from
 * `update`, which win over them. Defaults apply here.
 */
export function effectiveConfig(
  globals: Pick<
    Doc<"globals">,
    "maxParallelism" | "logLevel" | "overrides"
  > | null,
): Config {
  return {
    maxParallelism:
      globals?.overrides?.maxParallelism ??
      globals?.maxParallelism ??
      DEFAULT_MAX_PARALLELISM,
    logLevel:
      globals?.overrides?.logLevel ?? globals?.logLevel ?? DEFAULT_LOG_LEVEL,
  };
}

export async function getConfig(ctx: QueryCtx) {
  return effectiveConfig(await ctx.db.query("globals").unique());
}

export function validateConfig(config: Partial<Config>) {
  if (config.maxParallelism !== undefined) {
    if (config.maxParallelism > MAX_POSSIBLE_PARALLELISM) {
      throw new Error(`maxParallelism must be <= ${MAX_POSSIBLE_PARALLELISM}`);
    } else if (config.maxParallelism > MAX_PARALLELISM_SOFT_LIMIT) {
      createLogger(config.logLevel ?? DEFAULT_LOG_LEVEL).warn(
        `maxParallelism should be <= ${MAX_PARALLELISM_SOFT_LIMIT}, but is set to ${config.maxParallelism}. This will be an error in a future version.`,
      );
    } else if (config.maxParallelism < 0) {
      throw new Error("maxParallelism must be >= 0");
    }
  }
}

/**
 * Runtime override on top of the init args, e.g. to scale or pause
 * (`maxParallelism: 0`) a pool without a push. Overrides persist across pushes
 * until changed here.
 */
export const update = mutation({
  args: vConfig.partial(),
  handler: async (ctx, args) => {
    validateConfig(args);
    const globals = await ctx.db.query("globals").unique();
    const before = effectiveConfig(globals).maxParallelism;
    const overrides = { ...globals?.overrides };
    if (args.maxParallelism !== undefined) {
      overrides.maxParallelism = args.maxParallelism;
    }
    if (args.logLevel !== undefined) {
      overrides.logLevel = args.logLevel;
    }
    if (!globals) {
      await ctx.db.insert("globals", { overrides });
    } else {
      await ctx.db.patch("globals", globals._id, { overrides });
    }
    if (effectiveConfig({ ...globals, overrides }).maxParallelism > before) {
      await kickMainLoop(ctx, "kick");
    }
  },
});
