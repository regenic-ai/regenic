import { sqliteAuthorityPlugin } from "@regenic/authority-store";
import { fsBlobPlugin } from "@regenic/blob-store";
import {
  acceptedThreadSummaryRetrieverPlugin,
  contextProjectionCoordinatorPlugin,
  dailyDigestProjectionPlugin,
  deterministicThreadSummaryProjectorPlugin,
  indexedEventRetrieverPlugin,
  personalContextEnginePlugin,
} from "@regenic/context-engine";
import { sqliteContextLexicalIndexPlugin } from "@regenic/lexical-index";
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
      await host.plugin(indexedEventRetrieverPlugin);
      await host.plugin(acceptedThreadSummaryRetrieverPlugin);
      await host.plugin(deterministicThreadSummaryProjectorPlugin);
      await host.plugin(contextProjectionCoordinatorPlugin, {
        lexical_index: host.get("context-lexical-index"),
      });
      await host.plugin(dailyDigestProjectionPlugin);
      await host.plugin(personalContextEnginePlugin, { org_id: options.orgId });
      await host.plugin(modelProviderPlugin, options.model ?? { driver: "none" });
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
