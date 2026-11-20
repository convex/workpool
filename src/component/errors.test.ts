import { describe, expect, it } from "vitest";
import { ConvexError } from "convex/values";
import {
  getReschedule,
  getNonRetryableErrorMessage,
  isRescheduleError,
  RescheduleError,
  isNonRetryableError,
  NonRetryableError,
  failedResult,
} from "./errors.js";

class CustomTerminalError extends NonRetryableError {}

describe("errors", () => {
  it.each([
    null,
    false,
    0,
    "",
    "invalid input",
    { code: "INVALID", count: 7n },
  ])("preserves ConvexError data: %s", (data) => {
    const error = new ConvexError(data);
    expect(failedResult(error)).toEqual({
      kind: "failed",
      error: error.message,
      errorData: data,
    });
  });

  it("keeps ordinary failures as strings, even if they have a data property", () => {
    expect(
      failedResult(Object.assign(new Error("failure"), { data: "extra" })),
    ).toEqual({
      kind: "failed",
      error: "failure",
    });
    expect(failedResult("failure")).toEqual({
      kind: "failed",
      error: "failure",
    });
  });

  it("preserves NonRetryableError data without changing its error message", () => {
    const error = new NonRetryableError("invalid input");
    expect(failedResult(error)).toEqual({
      kind: "failed",
      error: "invalid input",
      errorData: error.data,
    });
  });

  it("identifies non-retryable error subclasses", () => {
    // Users should be able to model domain-specific terminal failures.
    const error = new CustomTerminalError("invalid input");

    expect(isNonRetryableError(error)).toBe(true);
    expect(getNonRetryableErrorMessage(error)).toBe("invalid input");
    // The ConvexError payload is the only data that can cross Convex boundaries.
    expect(error.data).toEqual({
      __convexWorkpoolNonRetryable: true,
      message: "invalid input",
    });
  });

  it("identifies ConvexError data from nested mutations", () => {
    // Nested mutations preserve ConvexError data instead of custom Error fields.
    const error = new ConvexError({
      __convexWorkpoolNonRetryable: true,
      message: "invalid input",
    });

    expect(isNonRetryableError(error)).toBe(true);
    expect(getNonRetryableErrorMessage(error)).toBe("invalid input");
  });

  it("identifies marker-compatible errors", () => {
    // The marker path keeps detection working across duplicated package modules.
    const error = new Error("invalid input");
    Object.assign(error, { __convexWorkpoolNonRetryable: true });

    expect(isNonRetryableError(error)).toBe(true);
    expect(getNonRetryableErrorMessage(error)).toBe("invalid input");
  });

  it("does not identify ordinary errors as non-retryable", () => {
    // Existing retry behavior depends on plain errors remaining retryable.
    expect(isNonRetryableError(new Error("temporary failure"))).toBe(false);
  });

  describe("RescheduleError", () => {
    it("carries its delay in ConvexError data", () => {
      const error = new RescheduleError({ delayMs: 5000 });
      expect(getReschedule(error)).toEqual({ delayMs: 5000 });
      expect(isNonRetryableError(error)).toBe(false);
    });

    it("defaults to no delay", () => {
      expect(getReschedule(new RescheduleError())).toEqual({ delayMs: 0 });
    });

    it("is identified after crossing a function boundary", () => {
      // Only ConvexError data survives ctx.runAction / ctx.runMutation.
      const data = new RescheduleError({ delayMs: 10 }).data;
      expect(getReschedule(new ConvexError(data))).toEqual({ delayMs: 10 });
    });

    it("ignores other errors", () => {
      expect(isRescheduleError(new Error("nope"))).toBe(false);
      expect(isRescheduleError(new ConvexError({ delayMs: 10 }))).toBe(false);
      expect(isRescheduleError(new NonRetryableError("nope"))).toBe(false);
    });

    it("rejects invalid delays", () => {
      expect(() => new RescheduleError({ delayMs: -1 })).toThrow();
      expect(() => new RescheduleError({ delayMs: NaN })).toThrow();
    });
  });
});
