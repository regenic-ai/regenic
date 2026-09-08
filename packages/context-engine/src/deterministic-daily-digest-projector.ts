import { createHash } from "node:crypto";
import {
  canonicalContextJson,
  hashContextArtifactInputs,
  type ContextArtifactProposal,
  type DailyDigestProjectionInput,
  type DailyDigestProjector,
  type ContextSourceEvent,
  type WeightHints,
} from "@regenic/domain";

export class DeterministicDailyDigestProjector implements DailyDigestProjector {
  readonly id = "daily-digest-deterministic";
  readonly algorithm_version = "daily-digest-d0-v2";

  async project(input: DailyDigestProjectionInput): Promise<ContextArtifactProposal | null> {
    assertUtcDate(input.utc_date);
    const heads = new Set(input.source.lifecycle_heads.map((head) => head.head_event_id));
    const selected = input.source.events
      .filter((event) => heads.has(event.event.event_id))
      .filter((event) => event.event.operation !== "tombstone")
      .filter((event) => event.event.occurred_at.slice(0, 10) === input.utc_date)
      .filter((event) => directionsFor(event).length > 0);
    const directions = DAILY_DIGEST_DIRECTIONS.map((direction) => ({
      direction,
      items: selectDirectionItems(selected, direction),
    })).filter((bucket) => bucket.items.length > 0);
    if (directions.length === 0) return null;
    const identities = new Set(directions.flatMap((bucket) =>
      bucket.items.map((item) => identity(item.event)),
    ));
    const evidenceEvents = input.source.events
      .filter((event) => identities.has(identity(event)))
      .sort(compareEvents);
    const inputRefs = evidenceEvents.map(referenceFor);
    const body = {
      schema_version: "1.0",
      utc_date: input.utc_date,
      source_read_epoch: input.source.read_epoch,
      rules_version: this.algorithm_version,
      item_count: directions.reduce((count, bucket) => count + bucket.items.length, 0),
      directions: directions.map((bucket) => ({
        direction: bucket.direction,
        items: bucket.items.map(toDigestItem),
      })),
    };
    const inputHash = hashContextArtifactInputs({ input_refs: inputRefs });
    return {
      id: `daily-digest:${sha256(canonicalContextJson([
        input.org_id,
        input.utc_date,
        input.generation,
        this.algorithm_version,
        inputHash,
      ]))}`,
      org_id: input.org_id,
      kind: "daily_digest",
      schema_version: "1.0",
      algorithm_version: this.algorithm_version,
      generation: input.generation,
      input_refs: inputRefs,
      input_hash: inputHash,
      body_hash: sha256(canonicalContextJson(body)),
      status: "proposed",
      required_scope_ids: [...new Set(evidenceEvents.flatMap((event) => event.required_scope_ids))].sort(),
      recorded_at: input.source.recorded_at,
      attrs: body,
    };
  }
}

export const DAILY_DIGEST_DIRECTIONS = [
  "product",
  "sales",
  "customer",
  "org",
  "finance",
  "risk",
] as const;

type DailyDigestDirection = (typeof DAILY_DIGEST_DIRECTIONS)[number];

interface DigestCandidate {
  event: ContextSourceEvent;
  score: number;
  item_kind: "metric_signal" | "bad_news" | "hypothesis";
}

function selectDirectionItems(
  events: ContextSourceEvent[],
  direction: DailyDigestDirection,
): DigestCandidate[] {
  const candidates = events
    .filter((event) => directionsFor(event).includes(direction))
    .flatMap((event) => {
      const itemKind = classify(event);
      return itemKind ? [{ event, score: score(event), item_kind: itemKind }] : [];
    });
  const byThread = new Map<string, DigestCandidate>();
  for (const candidate of candidates.sort(compareCandidates)) {
    const key = candidate.event.thread_id || candidate.event.event.event_id;
    if (!byThread.has(key)) byThread.set(key, candidate);
  }
  const folded = [...byThread.values()].sort(compareCandidates);
  const badNews = folded.filter((item) => item.item_kind === "bad_news");
  const rest = folded.filter((item) => item.item_kind !== "bad_news");
  return [...badNews.slice(0, 1), ...rest].slice(0, 7).sort(compareCandidates);
}

function directionsFor(event: ContextSourceEvent): DailyDigestDirection[] {
  const allowed = new Set<string>(DAILY_DIGEST_DIRECTIONS);
  return [...new Set((event.direction_tags ?? []).map((tag) => tag.trim().toLowerCase()))]
    .filter((tag): tag is DailyDigestDirection => allowed.has(tag))
    .sort();
}

function classify(event: ContextSourceEvent): DigestCandidate["item_kind"] | null {
  if (event.weight_hints?.evidence_class === "metric") return "metric_signal";
  const severity = event.attrs?.severity;
  if (severity === "high" || severity === "critical" || event.attrs?.bad_news === true) {
    return "bad_news";
  }
  return score(event) >= 1.5 ? "hypothesis" : null;
}

function score(event: ContextSourceEvent): number {
  const urgency = event.weight_hints?.urgency ?? 0;
  const importance = event.weight_hints?.importance ?? 0;
  const roleTier = event.weight_hints?.role_tier ?? 1;
  return Number(((urgency + importance * roleTier) * evidenceWeight(
    event.weight_hints?.evidence_class,
  )).toFixed(6));
}

const EVIDENCE_WEIGHTS: Record<NonNullable<WeightHints["evidence_class"]>, number> = {
  metric: 4,
  demo: 3,
  user_verbatim: 2.5,
  decision_record: 2.5,
  opinion: 1,
};

function evidenceWeight(evidenceClass: WeightHints["evidence_class"]): number {
  return evidenceClass ? EVIDENCE_WEIGHTS[evidenceClass] : 1;
}

function compareCandidates(left: DigestCandidate, right: DigestCandidate): number {
  return right.score - left.score || compareEvents(left.event, right.event);
}

function toDigestItem(candidate: DigestCandidate) {
  const { event } = candidate;
  return {
    item_kind: candidate.item_kind,
    score: candidate.score,
    event_id: event.event.event_id,
    ...(event.thread_id ? { thread_id: event.thread_id } : {}),
    ...(event.actor_id ? { actor_id: event.actor_id } : {}),
    occurred_at: event.event.occurred_at,
    ...(event.text === undefined ? {} : { text: event.text }),
  };
}

function assertUtcDate(value: string): void {
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    throw new Error("Daily digest requires a valid UTC date");
  }
}

function identity(event: ContextSourceEvent): string {
  return canonicalContextJson([event.event.source, event.event.external_id]);
}

function referenceFor(event: ContextSourceEvent) {
  return {
    event_id: event.event.event_id,
    source: event.event.source,
    external_id: event.event.external_id,
    operation: event.event.operation,
    occurred_at: event.event.occurred_at,
    ...(event.event.content_hash ? { content_hash: event.event.content_hash } : {}),
  };
}

function compareEvents(left: ContextSourceEvent, right: ContextSourceEvent): number {
  return left.event.ingested_at.localeCompare(right.event.ingested_at)
    || left.event.event_id.localeCompare(right.event.event_id);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
