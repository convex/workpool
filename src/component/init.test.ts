import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "./_generated/api.js";
import { getConfig } from "./config.js";
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
    expect(first?.init).toEqual({ maxParallelism: 3, logLevel: "ERROR" });
    expect(await t.run(getConfig)).toMatchObject({
      maxParallelism: 3,
      logLevel: "ERROR",
    });

    await t.mutation(internal.init.init, {
      maxParallelism: 3,
      logLevel: "ERROR",
    });
    const second = await t.run((ctx) => ctx.db.query("globals").collect());
    expect(second).toEqual([first]);
  });

  it("replaces the init config when args change, and drops removed args", async () => {
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

  it("wins over per-call client options, which still apply without it", async () => {
    const t = setupTest();
    await t.mutation(api.lib.enqueue, {
      ...enqueueAction,
      config: { maxParallelism: 4 },
    });
    expect((await t.run(getConfig)).maxParallelism).toBe(4);

    await t.mutation(internal.init.init, { maxParallelism: 9 });
    await t.mutation(api.lib.enqueue, {
      ...enqueueAction,
      config: { maxParallelism: 4 },
    });
    expect((await t.run(getConfig)).maxParallelism).toBe(9);

    // Dropping the arg falls back to the last per-call value.
    await t.mutation(internal.init.init, {});
    expect((await t.run(getConfig)).maxParallelism).toBe(4);
  });
});
