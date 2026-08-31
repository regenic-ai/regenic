import { createHash } from "node:crypto";
import type { ContextArtifact } from "./context-artifact";
import type { ContextBundle, ContextBundlePayload, ContextRedaction } from "./context-bundle";
import type { ContextBudgetLedger } from "./context-budget";
import type { EvidenceReference } from "./context-consumer";
import type { ContextRequest } from "./context-request";
import type { ContextSnapshot } from "./context-snapshot";

function canonicalValue(value: unknown, path: string): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Non-finite number at ${path}`);
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item, index) => canonicalValue(item, `${path}[${index}]`)).join(",")}]`;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`Unsupported object at ${path}`);
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalValue(record[key], `${path}.${key}`)}`)
      .join(",")}}`;
  }
  throw new TypeError(`Unsupported value at ${path}`);
}

export function canonicalContextJson(value: unknown): string {
  return canonicalValue(value, "$");
}

export function hashCanonicalContext(value: unknown): string {
  return createHash("sha256").update(canonicalContextJson(value)).digest("hex");
}

function sortedStrings(values: readonly string[]): string[] {
  return [...values].sort(compareStrings);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedEvidence(references: readonly EvidenceReference[]): EvidenceReference[] {
  return [...references].sort((left, right) =>
    compareStrings(canonicalContextJson(left), canonicalContextJson(right)),
  );
}

function normalizedLedger(ledger: ContextBudgetLedger): ContextBudgetLedger {
  return {
    ...ledger,
    sections: [...ledger.sections].sort((left, right) => compareStrings(left.kind, right.kind)),
  };
}

export function hashContextEvidenceReferences(references: readonly EvidenceReference[]): string {
  return hashCanonicalContext(sortedEvidence(references));
}

export function hashContextRequest(request: ContextRequest): string {
  const {
    id: _id,
    allowed_uses: allowedUses,
    anchors,
    filters,
    requested_kinds: requestedKinds,
    ...semantic
  } = request;
  return hashCanonicalContext({
    ...semantic,
    temporal: normalizeTemporal(semantic.temporal),
    allowed_uses: sortedStrings(allowedUses),
    ...(anchors
      ? {
          anchors: [...anchors].sort((left, right) =>
            compareStrings(`${left.kind}\u0000${left.id}`, `${right.kind}\u0000${right.id}`),
          ),
        }
      : {}),
    ...(requestedKinds
      ? { requested_kinds: sortedStrings(requestedKinds) }
      : {}),
    ...(filters
      ? {
          filters: {
            ...filters,
            ...(filters.sources ? { sources: sortedStrings(filters.sources) } : {}),
            ...(filters.thread_ids ? { thread_ids: sortedStrings(filters.thread_ids) } : {}),
            ...(filters.actor_ids ? { actor_ids: sortedStrings(filters.actor_ids) } : {}),
            ...(filters.occurred_after ? { occurred_after: normalizeTimestamp(filters.occurred_after) } : {}),
            ...(filters.occurred_before ? { occurred_before: normalizeTimestamp(filters.occurred_before) } : {}),
          },
        }
      : {}),
  });
}

export function hashContextArtifactInputs(artifact: Pick<ContextArtifact, "input_refs">): string {
  return hashContextEvidenceReferences(artifact.input_refs);
}

export function hashContextSnapshot(snapshot: ContextSnapshot): string {
  const { id: _id, content_hash: _contentHash, ...semantic } = snapshot;
  return hashCanonicalContext({
    ...semantic,
    budget_ledger: normalizedLedger(semantic.budget_ledger),
    degradation_flags: sortedStrings(semantic.degradation_flags),
  });
}

function sortedRedactions(redactions: readonly ContextRedaction[]): ContextRedaction[] {
  return [...redactions].sort((left, right) =>
    compareStrings(`${left.section}\u0000${left.category}`, `${right.section}\u0000${right.category}`),
  );
}

export function hashContextBundle(bundle: ContextBundle): string {
  const { content_hash: _contentHash, ...semantic } = bundle;
  return hashCanonicalContext({
    ...semantic,
    citations: sortedEvidence(semantic.citations),
    redactions: sortedRedactions(semantic.redactions),
    budget_ledger: normalizedLedger(semantic.budget_ledger),
    degradation_flags: sortedStrings(semantic.degradation_flags),
  });
}

export function hashContextBundlePayload(payload: ContextBundlePayload): string {
  return hashCanonicalContext({
    ...payload,
    citations: sortedEvidence(payload.citations),
    redactions: sortedRedactions(payload.redactions),
    budget_ledger: normalizedLedger(payload.budget_ledger),
    degradation_flags: sortedStrings(payload.degradation_flags),
  });
}

function normalizeTemporal(temporal: ContextRequest["temporal"]): ContextRequest["temporal"] {
  if (temporal.mode === "current") {
    return temporal;
  }
  if (temporal.mode === "history") {
    return temporal.valid_at
      ? { mode: "history", valid_at: normalizeTimestamp(temporal.valid_at) }
      : temporal;
  }
  return {
    mode: "as_of",
    recorded_at: normalizeTimestamp(temporal.recorded_at),
    ...(temporal.valid_at ? { valid_at: normalizeTimestamp(temporal.valid_at) } : {}),
  };
}

function normalizeTimestamp(value: string): string {
  return new Date(value).toISOString();
}