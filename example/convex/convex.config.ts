import { defineApp } from "convex/server";
import workpool from "@convex-dev/workpool/convex.config";
import workpoolOld from "@convex-dev/workpool-old/convex.config";
import staticHosting from "@convex-dev/static-hosting/convex.config";
import { internal } from "./_generated/api";

const app = defineApp({ httpPrefix: "/api" });
app.use(workpool, {
  name: "smallPool",
  args: { maxParallelism: 3, retryActionsByDefault: true, logLevel: "INFO" },
});
app.use(workpool, {
  name: "bigPool",
  args: {
    maxParallelism: 20,
    defaultRetryBehavior: { maxAttempts: 3, initialBackoffMs: 100, base: 2 },
    retryActionsByDefault: true,
    logLevel: "INFO",
  },
});
app.use(workpool, {
  name: "serializedPool",
  args: {
    maxParallelism: 1,
    retryActionsByDefault: true,
    logLevel: "INFO",
    onComplete: internal.example.logFailure,
  },
});
app.use(workpool, { name: "testWorkpool" });
app.use(workpoolOld, { name: "oldWorkpool" });
app.use(staticHosting, { httpPrefix: "/" });

export default app;
