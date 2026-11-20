/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import workpool from "@convex-dev/workpool/test";
import { api } from "../_generated/api";
import { initConvexTest } from "../setup.test";

describe("RescheduleError", () => {
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

  test("runs an action again without retries enabled", async () => {
    const id = await t.mutation(api.test.reschedule.enqueueFlakyAction, {
      reschedules: 3,
      failures: 0,
      delayMs: 1000,
    });

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await t.query(api.example.status, { id })).toEqual({
      state: "finished",
    });
    expect(await t.query(api.test.reschedule.attemptCount, {})).toBe(4);
    // onComplete only hears about the final attempt.
    expect(await t.query(api.test.reschedule.completions, {})).toEqual([
      "success",
    ]);
  });

  test("doesn't use up retry attempts", async () => {
    const id = await t.mutation(api.test.reschedule.enqueueFlakyAction, {
      reschedules: 2,
      failures: 2,
      delayMs: 0,
      maxAttempts: 3,
    });

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await t.query(api.example.status, { id })).toEqual({
      state: "finished",
    });
    // Two reschedules, two failures, then the third counted attempt succeeds.
    expect(await t.query(api.test.reschedule.attemptCount, {})).toBe(5);
    expect(await t.query(api.test.reschedule.completions, {})).toEqual([
      "success",
    ]);
  });

  test("still fails once retries run out", async () => {
    await t.mutation(api.test.reschedule.enqueueFlakyAction, {
      reschedules: 1,
      failures: 10,
      delayMs: 0,
      maxAttempts: 2,
    });

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await t.query(api.test.reschedule.attemptCount, {})).toBe(3);
    expect(await t.query(api.test.reschedule.completions, {})).toEqual([
      "failed",
    ]);
  });

  test("waits for the delay before running again", async () => {
    const id = await t.mutation(api.test.reschedule.enqueueFlakyAction, {
      reschedules: 1,
      failures: 0,
      delayMs: 60_000,
    });

    await vi.advanceTimersByTimeAsync(5_000);
    await t.finishInProgressScheduledFunctions();
    await vi.advanceTimersByTimeAsync(5_000);
    await t.finishInProgressScheduledFunctions();

    expect(await t.query(api.test.reschedule.attemptCount, {})).toBe(1);
    expect(await t.query(api.example.status, { id })).toMatchObject({
      state: "pending",
    });

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await t.query(api.test.reschedule.attemptCount, {})).toBe(2);
    expect(await t.query(api.test.reschedule.completions, {})).toEqual([
      "success",
    ]);
  });

  test("doesn't run again once canceled", async () => {
    const id = await t.mutation(api.test.reschedule.enqueueFlakyAction, {
      reschedules: 10,
      failures: 0,
      delayMs: 60_000,
    });

    await vi.advanceTimersByTimeAsync(5_000);
    await t.finishInProgressScheduledFunctions();
    await vi.advanceTimersByTimeAsync(5_000);
    await t.finishInProgressScheduledFunctions();
    expect(await t.query(api.test.reschedule.attemptCount, {})).toBe(1);

    await t.mutation(api.test.reschedule.cancel, { id });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await t.query(api.example.status, { id })).toEqual({
      state: "finished",
    });
    expect(await t.query(api.test.reschedule.attemptCount, {})).toBe(1);
    expect(await t.query(api.test.reschedule.completions, {})).toEqual([
      "canceled",
    ]);
  });

  // Run the loop and the first attempt, but not the 10s reschedule delay.
  async function runFirstAttempt() {
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(1_000);
      await t.finishInProgressScheduledFunctions();
    }
  }

  test("rolls back a mutation's writes when it reschedules", async () => {
    const id = await t.mutation(api.test.reschedule.enqueueWaitingMutation, {});

    await runFirstAttempt();
    expect(await t.query(api.example.status, { id })).toMatchObject({
      state: "pending",
    });

    await t.mutation(api.test.reschedule.markReady, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await t.query(api.example.status, { id })).toEqual({
      state: "finished",
    });
    // Only the attempt that didn't reschedule kept its write.
    expect(await t.query(api.test.reschedule.attemptCount, {})).toBe(1);
    expect(await t.query(api.test.reschedule.completions, {})).toEqual([
      "success",
    ]);
  });

  test("runs a query again", async () => {
    const id = await t.mutation(api.test.reschedule.enqueueWaitingQuery, {});

    await runFirstAttempt();
    expect(await t.query(api.example.status, { id })).toMatchObject({
      state: "pending",
    });

    await t.mutation(api.test.reschedule.markReady, {});
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    expect(await t.query(api.example.status, { id })).toEqual({
      state: "finished",
    });
    expect(await t.query(api.test.reschedule.completions, {})).toEqual([
      "success",
    ]);
  });
});
