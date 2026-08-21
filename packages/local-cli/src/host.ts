import { sqliteAuthorityPlugin } from "@regenic/authority-store";
import { fsBlobPlugin } from "@regenic/blob-store";
import { ingestPlugin, MemoryBlobStore } from "@regenic/domain";
import { createHost, definePlugin, type Host } from "@regenic/plugin-host";

const memoryBlobPlugin = definePlugin({
  name: "blobs-memory",
  apply(ctx) {
    ctx.provide("blobs", new MemoryBlobStore());
  },
});

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
    } else {
      await host.plugin(memoryBlobPlugin);
    }
    await host.plugin(ingestPlugin);
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
