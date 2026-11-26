import { getConvexSize } from "convex/values";

export const INLINE_METADATA_THRESHOLD = 8_000; // 8KB threshold
export const MAX_DOC_SIZE = 1_000_000; // Some buffer for 1MiB actual limit
const PAYLOAD_DOC_OVERHEAD = 78; // Size of { args: null, context: null }

/**
 * Decides whether a job's args and onComplete context are stored on the work
 * document, or separately in a payload document when they're large.
 * Throws if either is too large to store at all, or if both go in the
 * payload document and together exceed its size limit.
 */
export function layoutPayload(
  fnName: string,
  fnArgs: Record<string, unknown>,
  context: unknown,
): {
  /** Args to store on the work document, if they're small. */
  fnArgs?: Record<string, unknown>;
  /** Context to store on the work document, if it's small. */
  context?: unknown;
  /** What to store in a payload document, if anything. */
  payload?: { args?: Record<string, unknown>; context?: unknown };
  payloadSize?: number;
} {
  const fnArgsSize = getConvexSize(fnArgs as never);
  if (fnArgsSize > MAX_DOC_SIZE) {
    throw new Error(
      `Function arguments for function ${fnName} too large: ${fnArgsSize} bytes (max: ${MAX_DOC_SIZE} bytes)`,
    );
  }
  let contextSize = 0;
  if (context !== undefined) {
    contextSize = getConvexSize(context as never);
    if (contextSize > MAX_DOC_SIZE) {
      throw new Error(
        `OnComplete context for function ${fnName} too large: ${contextSize} bytes (max: ${MAX_DOC_SIZE} bytes)`,
      );
    }
  }
  if (fnArgsSize >= INLINE_METADATA_THRESHOLD) {
    // Args are large, store separately
    if (contextSize >= INLINE_METADATA_THRESHOLD) {
      // Context is also too big to inline, so both share one payload doc.
      // Each can pass its own check above and still overflow it together;
      // throw here, before the caller writes anything, rather than at the
      // payload insert (continueWithArgs in complete.ts relies on this).
      const combinedSize = fnArgsSize + contextSize + PAYLOAD_DOC_OVERHEAD;
      if (combinedSize > MAX_DOC_SIZE) {
        throw new Error(
          `Function arguments and onComplete context for function ${fnName} too large together: ${combinedSize} bytes (max: ${MAX_DOC_SIZE} bytes)`,
        );
      }
      return {
        payload: { args: fnArgs, context },
        payloadSize: fnArgsSize + contextSize + PAYLOAD_DOC_OVERHEAD,
      };
    }
    return {
      context,
      payload: { args: fnArgs },
      payloadSize: fnArgsSize + PAYLOAD_DOC_OVERHEAD,
    };
  }
  if (fnArgsSize + contextSize >= INLINE_METADATA_THRESHOLD) {
    // Args are small enough, but combined with context it's too big.
    // Store just context in this case.
    return {
      fnArgs,
      payload: { context },
      payloadSize: contextSize + PAYLOAD_DOC_OVERHEAD,
    };
  }
  return { fnArgs, context };
}
