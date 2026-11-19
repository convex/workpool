/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import workpool from "@convex-dev/workpool/test";
import { api, internal } from "./_generated/api";
import { initConvexTest } from "./setup.test";

type T = ReturnType<typeof initConvexTest>;

// Needs a convex-test that runs component inits (`runInits`, `args` in
// `registerComponent`); skipped on releases without it.
const supportsInit = "runInits" in initConvexTest();

function readConfig(t: T, name: string) {
  return (t as any).runInComponent(name, (ctx: any) =>
    ctx.db.query("globals").unique(),
  );
}

describe.skipIf(!supportsInit)("init args from convex.config.ts", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("each pool's init runs with the args its use() passes", async () => {
    const t = initConvexTest();
    workpool.register(t, "bigPool");
    workpool.register(t, "serializedPool");
    await t.mutation(api.example.enqueueOneMutation, { data: 1 });
    expect((await readConfig(t, "bigPool")).init).toEqual({
      maxParallelism: 20,
      defaultRetryBehavior: { maxAttempts: 3, initialBackoffMs: 100, base: 2 },
      retryActionsByDefault: true,
      logLevel: "INFO",
    });
    const serialized = await readConfig(t, "serializedPool");
    expect(serialized.init.maxParallelism).toBe(1);
    expect(serialized.init.onComplete).toBe("function://;example:logFailure");
  });

  test("a later push with changed args updates the config document", async () => {
    const t = initConvexTest();
    workpool.register(t, "smallPool");
    await (t as any).runInits();
    expect((await readConfig(t, "smallPool")).init.maxParallelism).toBe(3);

    workpool.register(t, "smallPool", { maxParallelism: 8 });
    await (t as any).runInits();
    const config = await readConfig(t, "smallPool");
    expect(config.init).toEqual({ maxParallelism: 8 });
    expect(config.logLevel).toBe("REPORT");
  });

  test("invalid args fail the push", async () => {
    const t = initConvexTest();
    workpool.register(t, "smallPool", { maxParallelism: 500 });
    await expect((t as any).runInits()).rejects.toThrow(
      /maxParallelism must be <= 200/,
    );
  });

  test("the pool-wide onComplete runs for work without its own", async () => {
    const t = initConvexTest();
    workpool.register(t, "serializedPool", {
      maxParallelism: 1,
      onComplete: internal.example.logFailure as any,
    });
    await (t as any).runInits();
    const work = await (t as any).runInComponent(
      "serializedPool",
      async (ctx: any) => ctx.db.query("globals").unique(),
    );
    expect(work.init.onComplete).toMatch(/^function:\/\//);
  });
});
