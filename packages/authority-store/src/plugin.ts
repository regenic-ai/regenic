import "@regenic/domain";
import { definePlugin } from "@regenic/plugin-host";
import { SqliteAuthorityStore } from "./sqlite-authority-store";

export interface SqliteAuthorityPluginConfig {
  path: string;
}

export const sqliteAuthorityPlugin = definePlugin<SqliteAuthorityPluginConfig>({
  name: "authority-sqlite",
  apply(ctx, config) {
    const store = new SqliteAuthorityStore(config.path);
    ctx.provide("authority", store);
    ctx.effect(() => () => {
      store.close();
    });
  },
});
