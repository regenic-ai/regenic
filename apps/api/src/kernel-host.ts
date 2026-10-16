import {
  contextProjectionCoordinatorPlugin,
  contextEmbeddingWorkerPlugin,
  dailyDigestProjectionPlugin,
  acceptedThreadSummaryRetrieverPlugin,
  deterministicEventRetrieverPlugin,
  deterministicThreadSummaryProjectorPlugin,
  indexedEventRetrieverPlugin,
  personalContextEnginePlugin,
} from "@regenic/context-engine";
import { sqliteContextLexicalIndexPlugin } from "@regenic/lexical-index";
import { localEmbeddingProviderPlugin, type LocalEmbeddingConfig } from "@regenic/embedding-provider";
import { sqliteContextVectorIndexPlugin } from "@regenic/vector-index";
import { contextRegistriesPlugin, ingestPlugin } from "@regenic/domain";
import {
  modelProviderPlugin,
  type ModelProviderPluginConfig,
} from "@regenic/model-provider";
import {
  createHost,
  type Host,
  type Plugin,
} from "@regenic/plugin-host";

export interface KernelPluginBinding<C> {
  plugin: Plugin<C>;
  config?: C;
}

export interface KernelHostOptions<A = unknown, B = unknown> {
  authority: KernelPluginBinding<A>;
  blobs: KernelPluginBinding<B>;
  orgId: string;
  lexicalDatabase?: string;
  embedding?: LocalEmbeddingConfig & { database: string };
  model?: ModelProviderPluginConfig;
}

export async function createKernelHost<A, B>(
  options: KernelHostOptions<A, B>,
): Promise<Host> {
  const host = await createHost();
  try {
    await host.plugin(options.authority.plugin, options.authority.config as A);
    await host.plugin(options.blobs.plugin, options.blobs.config as B);
    await host.plugin(ingestPlugin);
    await host.plugin(contextRegistriesPlugin);
    if (options.lexicalDatabase !== undefined) {
      await host.plugin(sqliteContextLexicalIndexPlugin, { path: options.lexicalDatabase });
      await host.plugin(indexedEventRetrieverPlugin);
    } else {
      await host.plugin(deterministicEventRetrieverPlugin);
    }
    await host.plugin(acceptedThreadSummaryRetrieverPlugin);
    await host.plugin(deterministicThreadSummaryProjectorPlugin);
    await host.plugin(contextProjectionCoordinatorPlugin, {
      lexical_index: options.lexicalDatabase === undefined
        ? undefined
        : host.get("context-lexical-index"),
    });
    await host.plugin(dailyDigestProjectionPlugin);
    await host.plugin(personalContextEnginePlugin, { org_id: options.orgId });
    await host.plugin(modelProviderPlugin, options.model ?? { driver: "none" });
    if (options.embedding) {
      await host.plugin(localEmbeddingProviderPlugin, options.embedding);
      await host.plugin(sqliteContextVectorIndexPlugin, { path: options.embedding.database });
      await host.plugin(contextEmbeddingWorkerPlugin, { org_id: options.orgId, ...options.embedding });
    }
    return host;
  } catch (error) {
    await host.dispose();
    throw error;
  }
}

export async function withKernelHost<A, B, T>(
  options: KernelHostOptions<A, B>,
  run: (host: Host) => Promise<T>,
): Promise<T> {
  const host = await createKernelHost(options);
  try {
    return await run(host);
  } finally {
    await host.dispose();
  }
}
