import "@regenic/domain";
import { definePlugin } from "@regenic/plugin-host";
import { SqliteSplitAuthorityStore } from "./sqlite-split-authority-store";

export interface SqliteAuthorityPluginConfig {
  path: string;
}

export const sqliteAuthorityPlugin = definePlugin<SqliteAuthorityPluginConfig>({
  name: "authority-sqlite",
  async apply(ctx, config) {
    const store = await SqliteSplitAuthorityStore.open(config.path);
    ctx.provide("authority", store);
    ctx.effect(() => () => store.close());
  },
});
