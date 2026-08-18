import type { EventRecord } from "./ingestion";

export const EVIDENCE_BUNDLE_SCHEMA_VERSION = "1.0" as const;

export interface EvidenceReference {
  event_id: string;
  source: string;
  external_id: string;
  operation: EventRecord["operation"];
  occurred_at: string;
  content_hash?: string;
}

export interface EvidenceBundle {
  schema_version: typeof EVIDENCE_BUNDLE_SCHEMA_VERSION;
  id: string;
  org_id: string;
  consumer_id: string;
  purpose: string;
  created_at: string;
  evidence: EvidenceReference[];
}

export interface ContextConsumer {
  publish(bundle: EvidenceBundle): Promise<void>;
}