/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import workpool from "@convex-dev/workpool/test";
import { api } from "../_generated/api";
import { initConvexTest } from "../setup.test";

describe("continueWith", () => {
  async function setupTest() {
    const t = initConvexTest();
    workpool.register(t, "smallPool");
    return t;
  }

  let t: Awaited<ReturnType<typeof setupTest>>;

  beforeEach(async () => {
    vi.useFakeTimers();
    t = await setupTest();
  });

  afterEach(async () => {
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    vi.useRealTimers();
  });

  test("commits each step of a mutation and completes once", async () => {
    const id = await t.mutation(api.test.continue.enqueueSum, { end: 5 });

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await t.query(api.example.status, { id })).toEqual({
      state: "finished",
    });
    expect(await t.query(api.test.continue.steps, {})).toEqual([1, 2, 3, 4, 5]);
    expect(await t.query(api.test.continue.completions, {})).toEqual([
      { result: "success", value: 15 },
    ]);
  });

  test("gives each step the full retry budget", async () => {
    await t.mutation(api.test.continue.enqueueSteps, {
      end: 3,
      delayMs: 0,
      failFirst: true,
      maxAttempts: 2,
    });

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    // Each step fails once and is retried. With a shared budget, step 2's
    // failure would have been the last attempt.
    expect(await t.query(api.test.continue.steps, {})).toEqual([
      1, 1, 2, 2, 3, 3,
    ]);
    expect(await t.query(api.test.continue.completions, {})).toEqual([
      { result: "success", value: 3 },
    ]);
  });

  test("stores large args separately", async () => {
    await t.mutation(api.test.continue.enqueueSteps, {
      end: 3,
      delayMs: 0,
      failFirst: false,
      paddingBytes: 20_000,
    });

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await t.query(api.test.continue.steps, {})).toEqual([1, 2, 3]);
    expect(await t.query(api.test.continue.completions, {})).toEqual([
      { result: "success", value: 3 },
    ]);
  });

  test("doesn't run the next step once canceled", async () => {
    const id = await t.mutation(api.test.continue.enqueueSteps, {
      end: 3,
      delayMs: 60_000,
      failFirst: false,
    });

    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(1_000);
      await t.finishInProgressScheduledFunctions();
    }
    expect(await t.query(api.test.continue.steps, {})).toEqual([1]);
    expect(await t.query(api.example.status, { id })).toMatchObject({
      state: "pending",
    });

    await t.mutation(api.test.continue.cancel, { id });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await t.query(api.test.continue.steps, {})).toEqual([1]);
    expect(await t.query(api.test.continue.completions, {})).toEqual([
      { result: "canceled" },
    ]);
  });

  test("fails if the next step's args are too large", async () => {
    await t.mutation(api.test.continue.enqueueOversized, {});

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const completions = await t.query(api.test.continue.completions, {});
    expect(completions).toHaveLength(1);
    expect(completions[0]).toMatchObject({ result: "failed" });
    expect(completions[0]!.error).toMatch(/too large/);
  });

  test("keeps onComplete context when the next step doesn't fit with it", async () => {
    // 600 KB args and 600 KB context each fit, but not in one payload doc.
    // layoutPayload throws before continueWithArgs writes anything, so the
    // old payload holding the context is still there for onComplete.
    await t.mutation(api.test.continue.enqueueOversizedWithContext, {});

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const completions = await t.query(api.test.continue.completions, {});
    expect(completions).toEqual([
      expect.objectContaining({ result: "failed", contextLength: 600_000 }),
    ]);
    expect(completions[0]!.error).toMatch(/too large together/);
  });

  test.each([0, 20_000])(
    "carries a large onComplete context across steps (args padding %i)",
    async (paddingBytes) => {
      await t.mutation(api.test.continue.enqueueSteps, {
        end: 3,
        delayMs: 0,
        failFirst: false,
        paddingBytes,
        contextBytes: 20_000,
      });

      await t.finishAllScheduledFunctions(vi.runAllTimers);

      expect(await t.query(api.test.continue.steps, {})).toEqual([1, 2, 3]);
      expect(await t.query(api.test.continue.completions, {})).toEqual([
        { result: "success", value: 3, contextLength: 20_000 },
      ]);
    },
  );

  test("drops the next step if canceled while a step is running", async () => {
    const id = await t.mutation(api.test.continue.enqueueSelfCanceling, {});

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await t.query(api.example.status, { id })).toEqual({
      state: "finished",
    });
    expect(await t.query(api.test.continue.steps, {})).toEqual([1]);
    expect(await t.query(api.test.continue.completions, {})).toEqual([
      { result: "canceled" },
    ]);
  });

  test("continues a query job", async () => {
    await t.mutation(api.test.continue.enqueueCountQuery, {});

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await t.query(api.test.continue.completions, {})).toEqual([
      { result: "success", value: 3 },
    ]);
  });

  test("mixes RescheduleError and continueWith in one job", async () => {
    // maxAttempts: 1 means any counted failure would end the job; neither
    // reschedules nor steps use up that attempt.
    await t.mutation(api.test.continue.enqueueMixed, { maxAttempts: 1 });

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await t.query(api.test.continue.steps, {})).toEqual([1, 1, 2, 2]);
    expect(await t.query(api.test.continue.completions, {})).toEqual([
      { result: "success", value: 2 },
    ]);
  });

  test("fails a job that returns the marker without args", async () => {
    await t.mutation(api.test.continue.enqueueBadMarker, {});

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const completions = await t.query(api.test.continue.completions, {});
    expect(completions).toEqual([
      expect.objectContaining({ result: "failed" }),
    ]);
    expect(completions[0]!.error).toMatch(/without an args object/);
  });
});
