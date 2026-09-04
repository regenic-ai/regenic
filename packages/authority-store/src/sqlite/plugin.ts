import { definePlugin } from "@regenic/plugin-host";
import { provideAuthorityServices } from "../bind";
import { SqliteSplitAuthorityStore } from "./sqlite-split-authority-store";

export interface SqliteAuthorityPluginConfig {
  path: string;
}

export const sqliteAuthorityPlugin = definePlugin<SqliteAuthorityPluginConfig>({
  name: "authority-sqlite",
  async apply(ctx, config) {
    const store = await SqliteSplitAuthorityStore.open(config.path);
    provideAuthorityServices(ctx, store);
  },
});
