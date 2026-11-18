import {
  postgresAuthorityPlugin,
  sqliteAuthorityPlugin,
} from "@regenic/authority-store";
import { fsBlobPlugin } from "@regenic/blob-store";
import { resolveAuthorityBackend, type AuthorityBackend } from "@regenic/config";
import {
  acceptedThreadSummaryRetrieverPlugin,
  contextProjectionCoordinatorPlugin,
  contextEmbeddingWorkerPlugin,
  hybridEventRetrieverPlugin,
  deterministicThreadSummaryProjectorPlugin,
  indexedEventRetrieverPlugin,
  personalContextEnginePlugin,
} from "@regenic/context-engine";
import { sqliteContextLexicalIndexPlugin } from "@regenic/lexical-index";
import { localEmbeddingProviderPlugin, type LocalEmbeddingConfig } from "@regenic/embedding-provider";
import { sqliteContextVectorIndexPlugin } from "@regenic/vector-index";
import { contextRegistriesPlugin, ingestPlugin, MemoryBlobStore } from "@regenic/domain";
import {
  modelProviderPlugin,
  type ModelProviderPluginConfig,
} from "@regenic/model-provider";
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
  orgId?: string;
  model?: ModelProviderPluginConfig;
  embedding?: LocalEmbeddingConfig;
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
    if (options.orgId !== undefined) {
      if (options.blobRoot === undefined) {
        throw new Error("Context commands require a Blob root");
      }
      await host.plugin(contextRegistriesPlugin);
      await host.plugin(sqliteContextLexicalIndexPlugin, {
        path: `${options.database}.lexical.db`,
      });
      if (!options.embedding) await host.plugin(indexedEventRetrieverPlugin);
      await host.plugin(acceptedThreadSummaryRetrieverPlugin);
      await host.plugin(deterministicThreadSummaryProjectorPlugin);
      await host.plugin(contextProjectionCoordinatorPlugin, {
        lexical_index: host.get("context-lexical-index"),
      });
      await host.plugin(personalContextEnginePlugin, { org_id: options.orgId, hybrid: options.embedding !== undefined });
      await host.plugin(modelProviderPlugin, options.model ?? { driver: "none" });
      if (options.embedding) {
        await host.plugin(localEmbeddingProviderPlugin, options.embedding);
        await host.plugin(sqliteContextVectorIndexPlugin, {
          path: `${options.database}.vector.db`, org_id: options.orgId,
          visual_enabled: options.embedding.visual_enabled,
        });
        await host.plugin(hybridEventRetrieverPlugin, {
          ...options.embedding, lexical_index: host.get("context-lexical-index"),
        });
        await host.plugin(contextEmbeddingWorkerPlugin, { org_id: options.orgId, ...options.embedding });
      }
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

export async function withLocalReadOnlyHost<T>(
  database: string,
  run: (host: Host) => Promise<T>,
): Promise<T> {
  const host = await createHost();
  try {
    await host.plugin(sqliteAuthorityPlugin, { path: database, readonly: true });
    return await run(host);
  } finally {
    await host.dispose();
  }
}

export interface BlobMaintenanceHostOptions {
  database?: string;
  blobRoot: string;
  env: NodeJS.ProcessEnv;
  readOnly: boolean;
}

export function resolveBlobMaintenanceBackend(
  options: BlobMaintenanceHostOptions,
): Exclude<AuthorityBackend, { driver: "none" }> {
  const driver = options.env.REGENIC_AUTHORITY_DRIVER?.trim().toLowerCase();
  if (driver === "postgres" && options.database !== undefined) {
    throw new Error("Do not pass --database when REGENIC_AUTHORITY_DRIVER=postgres");
  }
  if (driver === "postgres" && !options.env.DATABASE_URL?.trim()) {
    throw new Error("DATABASE_URL must be explicitly set for PostgreSQL Blob maintenance");
  }
  const backend = resolveAuthorityBackend({
    ...options.env,
    ...(options.database !== undefined ? { REGENIC_DATABASE: options.database } : {}),
    REGENIC_BLOB_ROOT: options.blobRoot,
  });
  if (backend.driver === "none") {
    throw new Error(
      "Blob maintenance requires --database for SQLite or REGENIC_AUTHORITY_DRIVER=postgres with DATABASE_URL",
    );
  }
  return backend;
}

export async function withBlobMaintenanceHost<T>(
  options: BlobMaintenanceHostOptions,
  run: (host: Host) => Promise<T>,
): Promise<T> {
  const backend = resolveBlobMaintenanceBackend(options);
  const host = await createHost();
  try {
    if (backend.driver === "sqlite") {
      await host.plugin(sqliteAuthorityPlugin, {
        path: backend.path,
        ...(options.readOnly ? { readonly: true } : {}),
      });
    } else {
      await host.plugin(postgresAuthorityPlugin, {
        connectionString: backend.url,
        migrate: false,
        readOnly: options.readOnly,
      });
    }
    await host.plugin(fsBlobPlugin, { root: backend.blobRoot });
    return await run(host);
  } finally {
    await host.dispose();
  }
}
