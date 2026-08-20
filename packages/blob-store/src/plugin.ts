import "@regenic/domain";
import { definePlugin } from "@regenic/plugin-host";
import { FsBlobStore } from "./fs-blob-store";

export interface FsBlobPluginConfig {
  root: string;
}

export const fsBlobPlugin = definePlugin<FsBlobPluginConfig>({
  name: "blobs-fs",
  apply(ctx, config) {
    ctx.provide("blobs", new FsBlobStore(config.root));
  },
});
