import { sqliteAuthorityPlugin } from "@regenic/authority-store";
import { fsBlobPlugin } from "@regenic/blob-store";
import { ingestPlugin } from "@regenic/domain";
import { dshTaskExecutor } from "@regenic/dsh-connector";
import { createHost, type Host } from "@regenic/plugin-host";

export interface PersonalHostOptions {
  database: string;
  blobRoot: string;
}

export async function createPersonalHost(
  options: PersonalHostOptions,
): Promise<Host> {
  const host = await createHost();
  try {
    await host.plugin(sqliteAuthorityPlugin, { path: options.database });
    await host.plugin(fsBlobPlugin, { root: options.blobRoot });
    await host.plugin(ingestPlugin);
    // Public default executor only. Private runtimes stay out of this tree.
    host.get("executors").register(dshTaskExecutor);
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
