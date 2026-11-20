import {
  defineApp,
  defineComponent,
  type FunctionReference,
} from "convex/server";
import { test } from "vitest";
import workpoolConfig from "@convex-dev/workpool/convex.config";

test("init args are type-checked in use()", () => {
  const app = defineApp();
  app.use(workpoolConfig, { args: { maxParallelism: 3 } });
  // @ts-expect-error maxParallelism is a number
  app.use(workpoolConfig, { args: { maxParallelism: "3" } });

  const required = defineComponent("required", {
    init: {} as FunctionReference<
      "mutation",
      "internal",
      { maxParallelism: number }
    >,
  });
  // @ts-expect-error args is required when the init has a required arg
  app.use(required);
  // @ts-expect-error maxParallelism is required
  app.use(required, { args: {} });
  app.use(required, { args: { maxParallelism: 1 } });
});
