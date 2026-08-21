import { sqliteAuthorityPlugin } from "@regenic/authority-store";
import { fsBlobPlugin } from "@regenic/blob-store";
import { ingestPlugin } from "@regenic/domain";
import { createHost, type Host } from "@regenic/plugin-host";

export interface PersonalHostOptions {
  database: string;
  blobRoot: string;
}

export async function withPersonalHost<T>(
  options: PersonalHostOptions,
  run: (host: Host) => Promise<T>,
): Promise<T> {
  const host = await createHost();
  try {
    await host.plugin(sqliteAuthorityPlugin, { path: options.database });
    await host.plugin(fsBlobPlugin, { root: options.blobRoot });
    await host.plugin(ingestPlugin);
    return await run(host);
  } finally {
    await host.dispose();
  }
}
