import { defineComponent } from "convex/server";
import batchWorker from "@convex-dev/batch-worker/convex.config.js";
import { internal } from "./_generated/api.js";

const component = defineComponent("workpool", { init: internal.init.init });
component.use(batchWorker, { env: { LOG_LEVEL: "REPORT" } });

export default component;
