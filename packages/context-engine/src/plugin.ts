import { definePlugin } from "@regenic/plugin-host";
import {
  type ContextEvidenceSource,
  type ContextPolicyEvaluator,
} from "@regenic/domain";
import { DeterministicContextEngine } from "./deterministic-context-engine";
import { DeterministicEventRetriever } from "./deterministic-event-retriever";

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