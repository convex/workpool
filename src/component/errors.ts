import { ConvexError } from "convex/values";
import type { RunResult } from "./shared.js";

export function failedResult(
  error: unknown,
): Extract<RunResult, { kind: "failed" }> {
  return {
    kind: "failed",
    error:
      getNonRetryableErrorMessage(error) ??
      (error instanceof Error ? error.message : String(error)),
    ...(error instanceof ConvexError ? { errorData: error.data ?? null } : {}),
  };
}

const NON_RETRYABLE_ERROR_MARKER = "__convexWorkpoolNonRetryable";

type NonRetryableErrorMarker = {
  readonly [NON_RETRYABLE_ERROR_MARKER]: true;
};

type NonRetryableErrorData = NonRetryableErrorMarker & {
  message: string;
};

/**
 * Throw this from workpool jobs when the failure should finish immediately
 * instead of using the configured retry behavior.
 */
export class NonRetryableError extends ConvexError<NonRetryableErrorData> {
  constructor(message: string, options?: ErrorOptions) {
    super({
      [NON_RETRYABLE_ERROR_MARKER]: true,
      message,
    });
    this.name = new.target.name;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export function isNonRetryableError(error: unknown): boolean {
  if (error instanceof NonRetryableError) {
    return true;
  }
  if (error instanceof ConvexError) {
    return getNonRetryableErrorData(error.data) !== undefined;
  }
  return (
    typeof error === "object" &&
    error !== null &&
    (error as Partial<NonRetryableErrorMarker>)[NON_RETRYABLE_ERROR_MARKER] ===
      true
  );
}

export function getNonRetryableErrorMessage(
  error: unknown,
): string | undefined {
  if (error instanceof ConvexError) {
    return getNonRetryableErrorData(error.data)?.message;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    (error as Partial<NonRetryableErrorMarker>)[NON_RETRYABLE_ERROR_MARKER] ===
      true
  ) {
    const message = (error as Partial<NonRetryableErrorData>).message;
    return typeof message === "string" ? message : undefined;
  }
  return undefined;
}

function getNonRetryableErrorData(
  data: unknown,
): NonRetryableErrorData | undefined {
  if (isNonRetryableErrorData(data)) {
    return data;
  }
  return undefined;
}

function isNonRetryableErrorData(data: unknown): data is NonRetryableErrorData {
  if (
    typeof data === "object" &&
    data !== null &&
    (data as Partial<NonRetryableErrorMarker>)[NON_RETRYABLE_ERROR_MARKER] ===
      true &&
    typeof (data as Partial<NonRetryableErrorData>).message === "string"
  ) {
    return true;
  }
  return false;
}

const RESCHEDULE_MARKER = "__convexWorkpoolReschedule";

type RescheduleErrorData = {
  readonly [RESCHEDULE_MARKER]: true;
  message: string;
  delayMs: number;
};

export type RescheduleOptions = {
  /**
   * How long to wait before running the job again, in milliseconds.
   * Defaults to 0: run again as soon as there is capacity.
   */
  delayMs?: number;
  /** Shown in logs. */
  message?: string;
};

/**
 * Throw this from a workpool job to run it again later with the same
 * arguments, without using up one of its retry attempts.
 *
 * The job stays pending in the meantime, so `onComplete` isn't called until
 * a later attempt finishes. If the job is canceled before it runs again, it
 * won't run again and `onComplete` is called with `kind: "canceled"`.
 *
 * In a mutation, throwing rolls back that mutation's writes, as with any
 * other error.
 */
export class RescheduleError extends ConvexError<RescheduleErrorData> {
  constructor(options?: RescheduleOptions) {
    const delayMs = options?.delayMs ?? 0;
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      throw new Error(
        `RescheduleError delayMs must be a non-negative number, got ${delayMs}`,
      );
    }
    super({
      [RESCHEDULE_MARKER]: true,
      message: options?.message ?? "Rescheduled",
      delayMs,
    });
    this.name = new.target.name;
  }
}

/**
 * If `error` is a {@link RescheduleError}, including one whose data was
 * passed through `ctx.runAction` or `ctx.runMutation`, returns its delay.
 */
export function getReschedule(error: unknown): { delayMs: number } | undefined {
  const data = error instanceof ConvexError ? error.data : undefined;
  if (
    typeof data === "object" &&
    data !== null &&
    (data as Partial<RescheduleErrorData>)[RESCHEDULE_MARKER] === true
  ) {
    const delayMs = (data as Partial<RescheduleErrorData>).delayMs;
    return {
      delayMs:
        typeof delayMs === "number" && Number.isFinite(delayMs) && delayMs > 0
          ? delayMs
          : 0,
    };
  }
  return undefined;
}

export function isRescheduleError(error: unknown): boolean {
  return getReschedule(error) !== undefined;
}
