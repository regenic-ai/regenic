/**
 * Unstable domain placeholders for the Phase 0 spike.
 * Do not treat shapes as Accepted until the owning RFC is Accepted.
 */

export * from "./ingestion";
export * from "./content-parts";
export * from "./content-resolution";
export * from "./channel-driver";
export * from "./message-contract";
export * from "./content-compact";
export * from "./thread-surface";
export * from "./inbox-query";
export * from "./ingestion-schema";
export * from "./canonicalization";
export * from "./arrangement";
export * from "./arrangement-service";
export * from "./ingestion-service";
export * from "./connector-runner";
export * from "./connector-registry";
export * from "./egress";
export * from "./connector-conformance";
export * from "./context-consumer";
export * from "./generic-import";
export * from "./memory-ingestion-stores";
export * from "./memory-connector-runtime-store";
export * from "./plugin-services";
export * from "./plugin";
export * from "./local-network";
export * from "./record-class";
export * from "./thread-facet";
export * from "./work";
export * from "./recipe-match";
export * from "./specification";
export * from "./recipe-trigger";
export * from "./job-control";
export * from "./attention";
export * from "./executor";
export * from "./executor-installation";
export * from "./session-executor";
export * from "./local-connector-executor";
export * from "./http-executor";
export * from "./work-delivery";
export * from "./work-policy";
export * from "./memory-work-store";

/** @unstable RFC 0001 */
export type ActorType = "human" | "agent" | "system";

/** @unstable RFC 0001 / 0004 */
export interface ActorRef {
  actor_type: ActorType;
  actor_id: string;
}

/** @unstable RFC 0001 */
export type StandardLayer = "stable_core" | "adjacent" | "frontier";

/** @unstable RFC 0001 */
export type StandardVersionStatus =
  | "draft"
  | "trial"
  | "active"
  | "deprecated";

/** @unstable RFC 0001 — identity only; full model waits SoftGate */
export interface StandardPlaceholder {
  id: string;
  slug: string;
  title: string;
  layer: StandardLayer;
  current_version_id: string | null;
}
