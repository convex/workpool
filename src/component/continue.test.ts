import { describe, expect, it } from "vitest";
import { continueWith, getContinuation } from "./continue.js";
import { MAX_SCHEDULE_AHEAD_MS } from "./shared.js";

describe("continueWith", () => {
  it("round-trips args and delay", () => {
    expect(getContinuation(continueWith({ a: 1 }, { delayMs: 5 }))).toEqual({
      args: { a: 1 },
      delayMs: 5,
    });
  });

  it("caps huge delays at four years", () => {
    const next = continueWith({}, { delayMs: Number.MAX_SAFE_INTEGER });
    expect(next.delayMs).toBe(MAX_SCHEDULE_AHEAD_MS);
    // A hand-built value skips continueWith's clamp; getContinuation clamps.
    expect(
      getContinuation({ ...next, delayMs: Number.MAX_SAFE_INTEGER }),
    ).toEqual({ args: {}, delayMs: MAX_SCHEDULE_AHEAD_MS });
  });

  it("rejects invalid delays", () => {
    expect(() => continueWith({}, { delayMs: -1 })).toThrow();
    expect(() => continueWith({}, { delayMs: NaN })).toThrow();
  });

  it("accepts plain args, including ones without a prototype", () => {
    const args = Object.assign(Object.create(null), { a: 1 });
    expect(getContinuation({ ...continueWith({}), args })).toEqual({
      args: { a: 1 },
      delayMs: 0,
    });
  });

  it("ignores values without the marker", () => {
    expect(getContinuation({ args: {}, delayMs: 0 })).toBeUndefined();
    expect(getContinuation(null)).toBeUndefined();
    expect(getContinuation(3)).toBeUndefined();
  });

  it("reports an error for the marker without usable args", () => {
    const marker = { ...continueWith({}) } as Record<string, unknown>;
    for (const args of [
      undefined,
      null,
      [1],
      "x",
      // Objects, but not plain ones: complete's v.record validator rejects
      // them, so getContinuation must too.
      new ArrayBuffer(8),
      new Date(0),
    ]) {
      expect(getContinuation({ ...marker, args })).toEqual({
        error: expect.stringMatching(/without an args object/),
      });
    }
  });
});
