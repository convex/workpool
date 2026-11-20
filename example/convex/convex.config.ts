import { defineApp } from "convex/server";
import workpool from "@convex-dev/workpool/convex.config";
import workpoolOld from "@convex-dev/workpool-old/convex.config";
import staticHosting from "@convex-dev/static-hosting/convex.config";

const app = defineApp({ httpPrefix: "/api" });
app.use(workpool, {
  name: "smallPool",
  args: { maxParallelism: 3, logLevel: "INFO" },
});
app.use(workpool, {
  name: "bigPool",
  args: { maxParallelism: 20, logLevel: "INFO" },
});
app.use(workpool, {
  name: "serializedPool",
  args: { maxParallelism: 1, logLevel: "INFO" },
});
app.use(workpool, { name: "testWorkpool" });
app.use(workpoolOld, { name: "oldWorkpool" });
app.use(staticHosting, { httpPrefix: "/" });

export default app;
