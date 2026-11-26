import { v } from "convex/values";
import { clampDelayMs } from "./shared.js";

const CONTINUE_MARKER = "__convexWorkpoolContinue";

/**
 * Returned from a workpool job by {@link continueWith}. Workpool runs the job
 * again with `args` instead of finishing it.
 */
// Args is Record<string, unknown> rather than Record<string, Value> so that
// arg objects with optional properties (`{ cursor?: string }`, whose values
// include `undefined`) type-check, matching Convex's DefaultFunctionArgs.
export type Continuation<Args extends Record<string, unknown>> = {
  readonly [CONTINUE_MARKER]: true;
  args: Args;
  delayMs: number;
};

/**
 * Return this from a workpool job to run the same function again with new
 * arguments, instead of finishing. Use it for work that proceeds in steps,
 * such as paging through a table: each step returns `continueWith` with the
 * cursor for the next page, and the last step returns its result.
 *
 * Unlike throwing, returning commits a mutation's writes, so each step keeps
 * its progress.
 *
 * - `onComplete` is called once: after the final step, or when a step fails
 *   or is canceled, including when the next step's args can't be stored.
 * - Each step gets the job's full `retryBehavior`: failures in earlier steps
 *   don't count against later ones.
 * - If the job is canceled, the next step doesn't run.
 *
 * If your function declares a `returns` validator, include
 * {@link vContinuation} in it.
 *
 * @param args The arguments for the next step. They must match the function's
 *   argument validator.
 * @param options.delayMs How long to wait before the next step, in
 *   milliseconds. Defaults to 0. Delays over four years are capped at four
 *   years, the same bound enqueue's `runAt` has.
 */
export function continueWith<Args extends Record<string, unknown>>(
  args: Args,
  options?: { delayMs?: number },
): Continuation<Args> {
  const delayMs = options?.delayMs ?? 0;
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new Error(
      `continueWith delayMs must be a non-negative number, got ${delayMs}`,
    );
  }
  return { [CONTINUE_MARKER]: true, args, delayMs: clampDelayMs(delayMs) };
}

/** Validates the value returned by {@link continueWith}. */
export const vContinuation = v.object({
  [CONTINUE_MARKER]: v.literal(true),
  args: v.record(v.string(), v.any()),
  delayMs: v.number(),
});

/**
 * If `value` came from {@link continueWith}, returns its args and delay.
 * Returns `{ error }` if `value` has the continueWith marker but no usable
 * `args`, so the worker fails the job instead of treating the marker object
 * as its final result. The delay is clamped again here because the value can
 * be built by hand, skipping continueWith's check.
 */
export function getContinuation(
  value: unknown,
):
  | { args: Record<string, unknown>; delayMs: number }
  | { error: string }
  | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    (value as Partial<Continuation<never>>)[CONTINUE_MARKER] !== true
  ) {
    return undefined;
  }
  const { args, delayMs } = value as Partial<Continuation<never>>;
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return {
      error: `Returned a continueWith value without an args object (got ${
        Array.isArray(args) ? "an array" : args === null ? "null" : typeof args
      }); use continueWith(args) to build it`,
    };
  }
  return {
    args,
    delayMs:
      typeof delayMs === "number" && Number.isFinite(delayMs) && delayMs > 0
        ? clampDelayMs(delayMs)
        : 0,
  };
}
