import type { Doc } from "./_generated/dataModel.js";
import {
  mutation,
  type MutationCtx,
  type QueryCtx,
} from "./_generated/server.js";
import {
  vConfig,
  DEFAULT_MAX_PARALLELISM,
  type Config,
  type InitConfig,
} from "./shared.js";
import { createLogger, DEFAULT_LOG_LEVEL } from "./logging.js";
import { kickMainLoop } from "./kick.js";

export const MAX_POSSIBLE_PARALLELISM = 200;
export const MAX_PARALLELISM_SOFT_LIMIT = 100;

/**
 * Init args win over the legacy per-call config, which wins over defaults.
 * An install whose parent passes no args (or that predates init) behaves as
 * before.
 */
export function effectiveConfig(globals: Doc<"globals"> | null): Config {
  const init: InitConfig = globals?.init ?? {};
  return {
    maxParallelism:
      init.maxParallelism ?? globals?.maxParallelism ?? DEFAULT_MAX_PARALLELISM,
    logLevel: init.logLevel ?? globals?.logLevel ?? DEFAULT_LOG_LEVEL,
  };
}

export async function getConfig(ctx: QueryCtx) {
  return effectiveConfig(await ctx.db.query("globals").unique());
}

export const update = mutation({
  args: vConfig.partial(),
  handler: async (ctx, args) => {
    const { previousValue } = await _getOrUpdateGlobals(ctx, args);
    if (args.maxParallelism && args.maxParallelism > previousValue) {
      await kickMainLoop(ctx, "kick");
    }
  },
});

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

export async function getOrUpdateGlobals(
  ctx: MutationCtx,
  config?: Partial<Config>,
): Promise<Config> {
  const { globals } = await _getOrUpdateGlobals(ctx, config);
  return effectiveConfig(globals);
}

/**
 * Legacy lazy update from per-call client options. Fields the init sets are
 * left alone, so a stale client option can't fight the deploy-time config.
 */
async function _getOrUpdateGlobals(ctx: MutationCtx, config?: Partial<Config>) {
  if (config) {
    validateConfig(config);
  }
  const globals = await ctx.db.query("globals").unique();
  const previousValue = effectiveConfig(globals).maxParallelism;
  const init = globals?.init ?? {};
  if (!globals) {
    const id = await ctx.db.insert("globals", {
      maxParallelism: config?.maxParallelism ?? DEFAULT_MAX_PARALLELISM,
      logLevel: config?.logLevel ?? DEFAULT_LOG_LEVEL,
    });
    return { globals: (await ctx.db.get("globals", id))!, previousValue };
  } else if (config) {
    let updated = false;
    if (
      init.maxParallelism === undefined &&
      config.maxParallelism !== undefined &&
      config.maxParallelism !== globals.maxParallelism
    ) {
      globals.maxParallelism = config.maxParallelism;
      updated = true;
    }
    if (
      init.logLevel === undefined &&
      config.logLevel &&
      config.logLevel !== globals.logLevel
    ) {
      globals.logLevel = config.logLevel;
      updated = true;
    }
    if (updated) {
      await ctx.db.replace("globals", globals._id, globals);
    }
  }
  return { globals, previousValue };
}
