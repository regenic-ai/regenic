import type { ActorRef } from "./actor";
import type { ContextBudget } from "./context-budget";
import type { ContextCandidateKind } from "./context-candidate";

export const CONTEXT_REQUEST_SCHEMA_VERSION = "1.0" as const;

export const CONTEXT_ALLOWED_USES = [
  "display",
  "reason",
  "draft",
  "execute",
] as const;

export type ContextAllowedUse = (typeof CONTEXT_ALLOWED_USES)[number];

export const CONTEXT_ANCHOR_KINDS = [
  "event",
  "conversation",
  "work_item",
  "decision",
  "entity",
] as const;

export type ContextAnchorKind = (typeof CONTEXT_ANCHOR_KINDS)[number];

export interface ContextAnchor {
  kind: ContextAnchorKind;
  id: string;
}

export type ContextTemporalSelection =
  | { mode: "current"; valid_at?: never; recorded_at?: never }
  | { mode: "history"; valid_at?: string; recorded_at?: never }
  | { mode: "as_of"; valid_at?: string; recorded_at: string };

export interface ContextRequestFilters {
  sources?: string[];
  thread_ids?: string[];
  actor_ids?: string[];
  occurred_after?: string;
  occurred_before?: string;
}

export interface ContextRequest {
  schema_version: typeof CONTEXT_REQUEST_SCHEMA_VERSION;
  id: string;
  org_id: string;
  principal: ActorRef;
  consumer_id: string;
  purpose: string;
  allowed_uses: ContextAllowedUse[];
  query?: string;
  anchors?: ContextAnchor[];
  filters?: ContextRequestFilters;
  temporal: ContextTemporalSelection;
  budget: ContextBudget;
  requested_kinds?: ContextCandidateKind[];
}