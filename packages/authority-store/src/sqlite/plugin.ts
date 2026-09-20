import { definePlugin } from "@regenic/plugin-host";
import { provideAuthorityServices } from "../bind";
import { SqliteAuthorityStore } from "./sqlite-authority-store";
import { SqliteSplitAuthorityStore } from "./sqlite-split-authority-store";

export interface SqliteAuthorityPluginConfig {
  path: string;
  readonly?: boolean;
}

export const sqliteAuthorityPlugin = definePlugin<SqliteAuthorityPluginConfig>({
  name: "authority-sqlite",
  async apply(ctx, config) {
    const store = config.readonly
      ? new SqliteAuthorityStore(config.path, { readonly: true })
      : await SqliteSplitAuthorityStore.open(config.path);
    provideAuthorityServices(ctx, store);
  },
});
