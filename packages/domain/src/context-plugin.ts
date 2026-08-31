import { definePlugin } from "@regenic/plugin-host";
import { MemoryContextArtifactStore } from "./memory-context-artifact-store";
import {
  MemoryContextProjectorRegistry,
  MemoryContextRetrieverRegistry,
} from "./context-registry";
import "./plugin-services";

export const contextRegistriesPlugin = definePlugin({
  name: "context-registries",
  apply(ctx) {
    ctx.provide("context-projectors", new MemoryContextProjectorRegistry());
    ctx.provide("context-retrievers", new MemoryContextRetrieverRegistry());
  },
});

export const contextRuntimePlugin = definePlugin({
  name: "context-runtime",
  apply(ctx) {
    ctx.provide("context-artifacts", new MemoryContextArtifactStore());
    ctx.provide("context-projectors", new MemoryContextProjectorRegistry());
    ctx.provide("context-retrievers", new MemoryContextRetrieverRegistry());
  },
});