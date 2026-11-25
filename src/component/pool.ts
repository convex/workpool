import { v } from "convex/values";
import { components } from "./_generated/api.js";
import { mutation, query, type QueryCtx } from "./_generated/server.js";
import { kickMainLoop } from "./kick.js";
import { WORKER_NAME } from "./shared.js";

const worker = { name: WORKER_NAME };

export async function getPoolStatus(ctx: QueryCtx) {
  const status = await ctx.runQuery(components.batchWorker.lib.status, worker);
  return status?.kind === "stopped" ? "paused" : (status?.kind ?? "idle");
}

export const status = query({
  args: {},
  returns: v.union(
    v.literal("idle"),
    v.literal("running"),
    v.literal("paused"),
  ),
  handler: getPoolStatus,
});

export const pause = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const status = await ctx.runQuery(
      components.batchWorker.lib.status,
      worker,
    );
    if (status?.kind === "stopped") return;
    // stop requires a registered worker. Register and stop in one transaction
    // so even the first enqueue after a cold pause sees a stopped worker.
    if (!status) await kickMainLoop(ctx);
    await ctx.runMutation(components.batchWorker.lib.stop, worker);
  },
});

export const resume = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await ctx.runMutation(components.batchWorker.lib.start, worker);
  },
});
