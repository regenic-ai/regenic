/**
 * Unstable domain placeholders for the Phase 0 spike.
 * Do not treat shapes as Accepted until the owning RFC is Accepted.
 */

export * from "./ingestion";
export * from "./ingestion-schema";

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
