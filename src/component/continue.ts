import { v, type Validator, type Value } from "convex/values";
import { clampDelayMs } from "./shared.js";

const CONTINUE_MARKER = "__convexWorkpoolContinue";

/** What {@link continueWith} accepts: Convex values, or undefined. */
export type ContinuationArgs = Record<string, Value | undefined>;

/**
 * Returned from a workpool job by {@link continueWith}. Workpool runs the job
 * again with `args` instead of finishing it.
 */
// Args allows `undefined` values so arg objects with optional properties
// (`{ cursor?: string }`) type-check, while still rejecting values Convex
// can't pass as function arguments, such as functions.
export type Continuation<Args extends ContinuationArgs> = {
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
 *   for good (retries exhausted or a non-retryable error), is canceled, or
 *   can't store the next step's args.
 * - Each step gets the job's full `retryBehavior`: failures in earlier steps
 *   don't count against later ones, and `previousAttempts` in `status`
 *   starts again at 0.
 * - If the job is canceled, the next step doesn't run.
 *
 * If your function declares a `returns` validator, include
 * {@link vContinuation} in it.
 *
 * @param args The arguments for the next step. They must match the function's
 *   argument validator.
 * @param options.delayMs How long to wait before the next step, in
 *   milliseconds. Defaults to 0. Delays over four years are capped at four
 *   years. (Enqueue treats a `runAt` over four years out differently: it
 *   logs an error and runs the job one year from now.)
 */
export function continueWith<Args extends ContinuationArgs>(
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

/**
 * Validates the value returned by {@link continueWith}. At runtime `args` must
 * be an object; its TypeScript type is `any` so a function declaring
 * `returns: v.union(v.number(), vContinuation)` still fits the enqueue
 * methods, which require continuation args to match the job's args. With
 * `v.record`'s type, `Record<string, any>`, args like `{ n: number }` would
 * not match.
 */
export const vContinuation = v.object({
  [CONTINUE_MARKER]: v.literal(true),
  args: v.record(v.string(), v.any()) as unknown as Validator<
    any,
    "required",
    string
  >,
  delayMs: v.number(),
});

/**
 * If `value` came from {@link continueWith}, returns its args and delay.
 * Returns `{ error }` if `value` has the continueWith marker but no usable
 * `args`, so the worker fails the job instead of treating the marker object
 * as its final result. `args` must be a plain object: an array or an
 * ArrayBuffer would pass a looser check here, then fail `complete`'s
 * `v.record` validator and leave the job stuck in `running`. The delay is
 * clamped again here because the value can be built by hand, skipping
 * continueWith's check.
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
  if (!isPlainObject(args)) {
    return {
      error: `Returned a continueWith value without an args object (got ${describeNonObject(
        args,
      )}); use continueWith(args) to build it`,
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

/** True for `{...}` objects, the only kind Convex accepts as function args. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function describeNonObject(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "object") {
    return `a ${Object.getPrototypeOf(value)?.constructor?.name ?? "non-plain object"}`;
  }
  return typeof value;
}
