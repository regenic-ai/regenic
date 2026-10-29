import { definePlugin } from "@regenic/plugin-host";
import {
  embeddingGeneration,
  type ContextEvidenceSource,
  type ContextLexicalIndex,
  type ContextPolicyEvaluator,
} from "@regenic/domain";
import { DeterministicContextEngine } from "./deterministic-context-engine";
import { DeterministicEventRetriever } from "./deterministic-event-retriever";
import { IndexedEventRetriever } from "./indexed-event-retriever";
import { AcceptedThreadSummaryRetriever } from "./accepted-thread-summary-retriever";
import { AuthorityContextEvidenceSource } from "./authority-context-source";
import { ContextProjectionCoordinator } from "./context-projection-coordinator";
import { DeterministicThreadSummaryProjector } from "./deterministic-thread-summary-projector";
import { DailyDigestProjectionCoordinator } from "./daily-digest-projection-runner";
import { PersonalContextPolicyEvaluator } from "./personal-context-policy";
import { ContextEmbeddingWorker } from "./context-embedding-worker";
import { HybridEventRetriever, HYBRID_RETRIEVAL_PROFILE } from "./hybrid-event-retriever";

export const hybridEventRetrieverPlugin = definePlugin<{
  lexical_index?: ContextLexicalIndex;
  chunk_tokens: number;
  max_chunks_per_event: number;
}>({
  name: "context-retriever-event-hybrid",
  inject: ["context-retrievers", "embedding", "context-vector-status"],
  apply(ctx, config) {
    const provider = ctx.get("embedding");
    return ctx.get("context-retrievers").register(new HybridEventRetriever(
      config.lexical_index ? new IndexedEventRetriever(config.lexical_index) : new DeterministicEventRetriever(),
      provider,
      ctx.get("context-vector-status").status === "ready" ? ctx.get("context-vector-index") : undefined,
      embeddingGeneration(provider.descriptor, config.chunk_tokens, config.max_chunks_per_event),
      ctx.get("context-vector-status").status === "ready" ? ctx.get("context-vector-generations") : undefined,
    ));
  },
});

export const contextEmbeddingWorkerPlugin = definePlugin<{
  org_id: string; chunk_tokens: number; max_chunks_per_event: number;
}>({
  name: "context-embedding-worker",
  inject: ["context-authority", "blobs", "embedding", "context-vector-index", "context-embedding-jobs"],
  apply(ctx, config) {
    const provider = ctx.get("embedding");
    const worker = new ContextEmbeddingWorker(
      config.org_id,
      new AuthorityContextEvidenceSource(ctx.get("context-authority"), ctx.get("blobs"), true),
      provider, ctx.get("context-vector-index"), ctx.get("context-embedding-jobs"),
      embeddingGeneration(provider.descriptor, config.chunk_tokens, config.max_chunks_per_event),
      ctx.get("context-vector-generations"),
    );
    ctx.provide("context-embedding-worker", worker);
    ctx.effect(() => () => worker.stop());
  },
});

export const deterministicEventRetrieverPlugin = definePlugin({
  name: "context-retriever-event-deterministic",
  inject: ["context-retrievers"],
  apply(ctx) {
    return ctx.get("context-retrievers").register(new DeterministicEventRetriever());
  },
});

export interface DeterministicContextEnginePluginConfig {
  source: ContextEvidenceSource;
  policy: ContextPolicyEvaluator;
}

export const deterministicContextEnginePlugin = definePlugin<DeterministicContextEnginePluginConfig>({
  name: "context-engine-deterministic",
  inject: ["context-artifacts", "context-retrievers"],
  apply(ctx, config) {
    ctx.provide("context", new DeterministicContextEngine({
      source: config.source,
      policy: config.policy,
      artifacts: ctx.get("context-artifacts"),
      retrievers: ctx.get("context-retrievers"),
    }));
  },
});

export interface PersonalContextEnginePluginConfig {
  org_id: string;
  actor_id?: string;
  hybrid?: boolean;
}

export const personalContextEnginePlugin = definePlugin<PersonalContextEnginePluginConfig>({
  name: "context-engine-personal",
  inject: ["blobs", "context-authority", "context-artifacts", "context-retrievers"],
  apply(ctx, config) {
    const source = new AuthorityContextEvidenceSource(
      ctx.get("context-authority"),
      ctx.get("blobs"),
    );
    const policy = new PersonalContextPolicyEvaluator({
      org_id: config.org_id,
      principal: {
        actor_type: "human",
        actor_id: config.actor_id ?? config.org_id,
      },
    });
    ctx.provide("context", new DeterministicContextEngine({
      source,
      policy,
      artifacts: ctx.get("context-artifacts"),
      retrievers: ctx.get("context-retrievers"),
      retrieval_profile: config.hybrid ? HYBRID_RETRIEVAL_PROFILE : undefined,
    }));
  },
});

export interface ContextProjectionCoordinatorPluginConfig {
  lexical_index?: ContextLexicalIndex;
}

export const contextProjectionCoordinatorPlugin = definePlugin<ContextProjectionCoordinatorPluginConfig>({
  name: "context-projection-coordinator",
  inject: ["blobs", "context-authority", "context-artifacts", "context-projectors"],
  apply(ctx, config) {
    ctx.provide("context-projections", new ContextProjectionCoordinator(
      ctx.get("context-authority"),
      ctx.get("context-artifacts"),
      ctx.get("context-projectors"),
      ctx.get("blobs"),
      config?.lexical_index,
    ));
  },
});

export const deterministicThreadSummaryProjectorPlugin = definePlugin({
  name: "context-projector-thread-summary-deterministic",
  inject: ["context-projectors"],
  apply(ctx) {
    return ctx.get("context-projectors").register(new DeterministicThreadSummaryProjector());
  },
});

export const indexedEventRetrieverPlugin = definePlugin({
  name: "context-retriever-event-lexical-indexed",
  inject: ["context-retrievers", "context-lexical-index"],
  apply(ctx) {
    return ctx.get("context-retrievers").register(
      new IndexedEventRetriever(ctx.get("context-lexical-index")),
    );
  },
});

export const acceptedThreadSummaryRetrieverPlugin = definePlugin({
  name: "context-retriever-thread-summary-accepted",
  inject: ["blobs", "context-artifacts", "context-retrievers"],
  apply(ctx) {
    return ctx.get("context-retrievers").register(new AcceptedThreadSummaryRetriever(
      ctx.get("context-artifacts"),
      ctx.get("blobs"),
    ));
  },
});

export const dailyDigestProjectionPlugin = definePlugin({
  name: "context-daily-digest-projection",
  inject: ["blobs", "context-authority", "context-artifacts", "daily-digest-policy", "daily-digest-coverage-alerts"],
  apply(ctx) {
    ctx.provide("context-daily-digests", new DailyDigestProjectionCoordinator(
      new AuthorityContextEvidenceSource(ctx.get("context-authority"), ctx.get("blobs")),
      ctx.get("context-artifacts"),
      ctx.get("blobs"),
      undefined,
      ctx.get("daily-digest-policy"),
      ctx.get("daily-digest-coverage-alerts"),
    ));
  },
});