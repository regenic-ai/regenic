import { sqliteAuthorityPlugin } from "@regenic/authority-store";
import { fsBlobPlugin } from "@regenic/blob-store";
import {
  deterministicEventRetrieverPlugin,
  personalContextEnginePlugin,
} from "@regenic/context-engine";
import { contextRegistriesPlugin, ingestPlugin } from "@regenic/domain";
import { createHost, type Host } from "@regenic/plugin-host";

export interface PersonalHostOptions {
  database: string;
  blobRoot: string;
  orgId: string;
}

export async function createPersonalHost(
  options: PersonalHostOptions,
): Promise<Host> {
  const host = await createHost();
  try {
    await host.plugin(sqliteAuthorityPlugin, { path: options.database });
    await host.plugin(fsBlobPlugin, { root: options.blobRoot });
    await host.plugin(ingestPlugin);
    await host.plugin(contextRegistriesPlugin);
    await host.plugin(deterministicEventRetrieverPlugin);
    await host.plugin(personalContextEnginePlugin, { org_id: options.orgId });
    return host;
  } catch (error) {
    await host.dispose();
    throw error;
  }
}

export async function withPersonalHost<T>(
  options: PersonalHostOptions,
  run: (host: Host) => Promise<T>,
): Promise<T> {
  const host = await createPersonalHost(options);
  try {
    return await run(host);
  } finally {
    await host.dispose();
  }
}
