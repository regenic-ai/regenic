import { sqliteAuthorityPlugin } from "@regenic/authority-store";
import { fsBlobPlugin } from "@regenic/blob-store";
import { ingestPlugin } from "@regenic/domain";
import { createHost, type Host } from "@regenic/plugin-host";

export interface LocalHostOptions {
  database: string;
  blobRoot?: string;
}

export async function createLocalHost(options: LocalHostOptions): Promise<Host> {
  const host = await createHost();
  try {
    await host.plugin(sqliteAuthorityPlugin, { path: options.database });
    if (options.blobRoot !== undefined) {
      await host.plugin(fsBlobPlugin, { root: options.blobRoot });
      await host.plugin(ingestPlugin);
    }
    return host;
  } catch (error) {
    await host.dispose();
    throw error;
  }
}

export async function withLocalHost<T>(
  options: LocalHostOptions,
  run: (host: Host) => Promise<T>,
): Promise<T> {
  const host = await createLocalHost(options);
  try {
    return await run(host);
  } finally {
    await host.dispose();
  }
}
