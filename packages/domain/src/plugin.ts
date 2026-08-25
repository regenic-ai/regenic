import { definePlugin } from "@regenic/plugin-host";
import { MemoryConnectorRegistry } from "./connector-registry";
import { MemoryEgressRegistry } from "./egress";
import { MemoryExecutorRegistry } from "./executor";
import { IngestionService } from "./ingestion-service";
import "./plugin-services";

export const ingestPlugin = definePlugin({
  name: "ingest",
  inject: ["authority", "blobs"],
  apply(ctx) {
    ctx.provide("ingest", new IngestionService(ctx.get("blobs"), ctx.get("authority")));
    ctx.provide("connectors", new MemoryConnectorRegistry());
    ctx.provide("egress", new MemoryEgressRegistry());
    ctx.provide("executors", new MemoryExecutorRegistry());
  },
});
