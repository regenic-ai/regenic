import { definePlugin } from "@regenic/plugin-host";
import { provideAuthorityServices } from "../bind";
import { PostgresAuthorityStore } from "./store";

export interface PostgresAuthorityPluginConfig {
  connectionString: string;
  migrate?: boolean;
  readOnly?: boolean;
}

export const postgresAuthorityPlugin = definePlugin<PostgresAuthorityPluginConfig>({
  name: "authority-postgres",
  async apply(ctx, config) {
    const store = await PostgresAuthorityStore.open(config.connectionString, {
      ...(config.migrate !== undefined ? { migrate: config.migrate } : {}),
      ...(config.readOnly !== undefined ? { readOnly: config.readOnly } : {}),
    });
    provideAuthorityServices(ctx, store);
  },
});
