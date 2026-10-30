import {
  type FunctionReference,
  type FunctionReference_future,
  type FunctionType,
  type FunctionVisibility,
  type GenericActionCtx,
  type GenericDataModel,
  type GenericMutationCtx,
  type GenericQueryCtx,
  getFunctionAddress,
  getFunctionName,
} from "convex/server";

/* Type utils follow */

export type QueryCtx = Pick<GenericQueryCtx<GenericDataModel>, "runQuery">;
export type MutationCtx = Pick<
  GenericMutationCtx<GenericDataModel>,
  "runQuery" | "runMutation"
>;
export type ActionCtx = Pick<
  GenericActionCtx<GenericDataModel>,
  "runQuery" | "runMutation" | "runAction"
>;

export function safeFunctionName(
  f:
    | FunctionReference<FunctionType, FunctionVisibility>
    | FunctionReference_future<FunctionType, FunctionVisibility>,
) {
  const address = getFunctionAddress(f);
  return (
    address.name ||
    address.reference ||
    address.functionHandle ||
    getFunctionName(f)
  );
}
