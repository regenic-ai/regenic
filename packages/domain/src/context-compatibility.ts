import {
  EVIDENCE_BUNDLE_SCHEMA_VERSION,
  type EvidenceBundle,
  type EvidenceReference,
} from "./context-consumer";
import type { ContextBundle } from "./context-bundle";
import { canonicalContextJson } from "./context-canonical";

export function projectEvidenceBundleV1(
  bundle: ContextBundle,
  createdAt: string,
): EvidenceBundle {
  if (typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt))) {
    throw new TypeError("Evidence bundle created_at must be an ISO timestamp");
  }
  return {
    schema_version: EVIDENCE_BUNDLE_SCHEMA_VERSION,
    id: `evidence-bundle:${bundle.content_hash}`,
    org_id: bundle.org_id,
    consumer_id: bundle.consumer_id,
    purpose: bundle.purpose,
    created_at: new Date(createdAt).toISOString(),
    evidence: uniqueEvidence(bundle.citations),
  };
}

function uniqueEvidence(references: readonly EvidenceReference[]): EvidenceReference[] {
  const values = new Map<string, EvidenceReference>();
  for (const reference of references) {
    values.set(canonicalContextJson(reference), structuredClone(reference));
  }
  return [...values.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([, reference]) => reference);
}