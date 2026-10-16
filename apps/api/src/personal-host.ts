import { sqliteAuthorityPlugin } from "@regenic/authority-store";
import { fsBlobPlugin } from "@regenic/blob-store";
import type { ModelProviderPluginConfig } from "@regenic/model-provider";
import type { Host } from "@regenic/plugin-host";
import { createKernelHost } from "./kernel-host";

export interface PersonalHostOptions {
  database: string;
  blobRoot: string;
  orgId: string;
  model?: ModelProviderPluginConfig;
}

export async function createPersonalHost(
  options: PersonalHostOptions,
): Promise<Host> {
  return createKernelHost({
    authority: { plugin: sqliteAuthorityPlugin, config: { path: options.database } },
    blobs: { plugin: fsBlobPlugin, config: { root: options.blobRoot } },
    orgId: options.orgId,
    lexicalDatabase: `${options.database}.lexical.db`,
    model: options.model,
  });
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
