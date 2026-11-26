import { getConvexSize } from "convex/values";

export const INLINE_METADATA_THRESHOLD = 8_000; // 8KB threshold
export const MAX_DOC_SIZE = 1_000_000; // Some buffer for 1MiB actual limit
/**
 * The backend's limit on one document, system fields included (MAX_USER_SIZE
 * in the Convex backend; convex-test enforces the same limit on insert).
 */
export const MAX_DOCUMENT_SIZE = 1 << 20;
// getDocumentSize of { args: null, context: null } with a 32-character _id
// and its _creationTime. Real args and context replace the two 1-byte nulls,
// which leaves 2 bytes of slack for a longer _id.
const PAYLOAD_DOC_OVERHEAD = 78;

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
      // Compare against the backend's real limit, not MAX_DOC_SIZE: before
      // this check, the payload insert was the only limit on the pair, so
      // anything the backend stores must still be accepted.
      const combinedSize = fnArgsSize + contextSize + PAYLOAD_DOC_OVERHEAD;
      if (combinedSize > MAX_DOCUMENT_SIZE) {
        throw new Error(
          `Function arguments and onComplete context for function ${fnName} too large together: ${combinedSize} bytes (max: ${MAX_DOCUMENT_SIZE} bytes)`,
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
