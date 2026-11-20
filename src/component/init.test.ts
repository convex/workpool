import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import { getConfig } from "./config.js";
import { DEFAULT_LOG_LEVEL } from "./logging.js";
import { DEFAULT_MAX_PARALLELISM } from "./shared.js";
import { setupTest } from "./setup.test.js";

// The component's own tests run it as the app, where inits don't run on their
// own, so these call the init directly as a push would.
describe("init", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const enqueueAction = {
    fnHandle: "function://;work:act",
    fnName: "work:act",
    fnArgs: {},
    fnType: "action" as const,
    runAt: 0,
  };

  it("upserts the config document and leaves it alone when args are unchanged", async () => {
    const t = setupTest();
    await t.mutation(internal.init.init, {
      maxParallelism: 3,
      logLevel: "ERROR",
    });
    const first = await t.run((ctx) => ctx.db.query("globals").unique());
    expect(first).toMatchObject({ maxParallelism: 3, logLevel: "ERROR" });

    await t.mutation(internal.init.init, {
      maxParallelism: 3,
      logLevel: "ERROR",
    });
    const second = await t.run((ctx) => ctx.db.query("globals").collect());
    expect(second).toEqual([first]);
  });

  it("keeps a config.update override across pushes until it's updated", async () => {
    const t = setupTest();
    await t.mutation(internal.init.init, { maxParallelism: 3 });
    await t.mutation(api.config.update, { maxParallelism: 0 });
    const effective = () =>
      t.run(async (ctx) => (await getConfig(ctx)).maxParallelism);
    expect(await effective()).toBe(0);

    await t.mutation(internal.init.init, { maxParallelism: 8 });
    expect(await effective()).toBe(0);

    await t.mutation(api.config.update, { maxParallelism: 5 });
    expect(await effective()).toBe(5);
  });

  it("replaces the config when args change, and defaults removed args", async () => {
    const t = setupTest();
    await t.mutation(internal.init.init, {
      maxParallelism: 3,
      logLevel: "ERROR",
    });
    await t.mutation(internal.init.init, { maxParallelism: 7 });
    expect(await t.run(getConfig)).toMatchObject({
      maxParallelism: 7,
      logLevel: "REPORT",
    });
  });

  it("schedules a kick only when maxParallelism grows", async () => {
    const t = setupTest();
    await t.mutation(internal.init.init, { maxParallelism: 5 });
    await t.mutation(internal.init.init, { maxParallelism: 2 });
    await t.mutation(internal.init.init, { maxParallelism: 20 });
    const scheduled = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(scheduled.map((s) => s.name)).toEqual(["kick:kick"]);
  });

  it("rejects an out-of-range maxParallelism, which would fail the push", async () => {
    const t = setupTest();
    await expect(
      t.mutation(internal.init.init, { maxParallelism: 500 }),
    ).rejects.toThrow(/maxParallelism must be <= 200/);
  });

  it("supplies the config enqueue reads, with defaults before it runs", async () => {
    const t = setupTest();
    await t.mutation(api.lib.enqueue, enqueueAction);
    expect(await t.run(getConfig)).toEqual({
      maxParallelism: DEFAULT_MAX_PARALLELISM,
      logLevel: DEFAULT_LOG_LEVEL,
    });
    expect(await t.run((ctx) => ctx.db.query("globals").unique())).toBeNull();

    await t.mutation(internal.init.init, { maxParallelism: 9 });
    await t.mutation(api.lib.enqueue, enqueueAction);
    expect((await t.run(getConfig)).maxParallelism).toBe(9);
  });
});
