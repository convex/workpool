import { ConvexError } from "convex/values";
import { clampDelayMs, type RunResult } from "./shared.js";

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
   * Defaults to 0: run again as soon as there is capacity. Delays over four
   * years are capped at four years. (Enqueue treats a `runAt` over four years
   * out differently: it logs an error and runs the job one year from now.)
   */
  delayMs?: number;
  /** Included in the worker's "rescheduled itself" log line. */
  message?: string;
};

/**
 * Throw this from a workpool job to run it again later with the same
 * arguments, without using up one of its retry attempts.
 *
 * The job stays pending in the meantime, so `onComplete` isn't called until
 * a later attempt finishes. Rescheduling isn't bounded by
 * `retry.maxAttempts`: a job that keeps throwing this keeps running, so stop
 * it yourself by canceling it, or in an action by counting runs in your own
 * table with `ctx.runMutation` before throwing. A mutation or query job can't
 * keep such a count, because throwing rolls back the mutation's writes and a
 * query can't write. If the job is canceled before it runs again, it
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
      delayMs: clampDelayMs(delayMs),
    });
    this.name = new.target.name;
  }
}

/**
 * If `error` is a {@link RescheduleError}, including one whose data was
 * passed through `ctx.runAction` or `ctx.runMutation`, returns its delay and
 * message. The delay is clamped again here because the error data can be
 * built by hand as a plain `ConvexError`, skipping the constructor's check.
 */
export function getReschedule(
  error: unknown,
): { delayMs: number; message?: string } | undefined {
  const data = error instanceof ConvexError ? error.data : undefined;
  if (
    typeof data === "object" &&
    data !== null &&
    (data as Partial<RescheduleErrorData>)[RESCHEDULE_MARKER] === true
  ) {
    const { delayMs, message } = data as Partial<RescheduleErrorData>;
    return {
      delayMs:
        typeof delayMs === "number" && Number.isFinite(delayMs) && delayMs > 0
          ? clampDelayMs(delayMs)
          : 0,
      ...(typeof message === "string" ? { message } : {}),
    };
  }
  return undefined;
}

export function isRescheduleError(error: unknown): boolean {
  return getReschedule(error) !== undefined;
}
