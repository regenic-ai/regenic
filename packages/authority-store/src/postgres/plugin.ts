import { definePlugin } from "@regenic/plugin-host";
import { provideAuthorityServices } from "../bind";
import { PostgresAuthorityStore } from "./store";

export interface PostgresAuthorityPluginConfig {
  connectionString: string;
}

export const postgresAuthorityPlugin = definePlugin<PostgresAuthorityPluginConfig>({
  name: "authority-postgres",
  async apply(ctx, config) {
    const store = await PostgresAuthorityStore.open(config.connectionString);
    provideAuthorityServices(ctx, store);
  },
});
