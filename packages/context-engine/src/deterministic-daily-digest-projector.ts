import { createHash } from "node:crypto";
import {
  canonicalContextJson,
  hashContextArtifactInputs,
  type ContextArtifactProposal,
  type DailyDigestProjectionInput,
  type DailyDigestProjector,
  type ContextSourceEvent,
} from "@regenic/domain";

export class DeterministicDailyDigestProjector implements DailyDigestProjector {
  readonly id = "daily-digest-deterministic";
  readonly algorithm_version = "daily-digest-d0-v1";

  async project(input: DailyDigestProjectionInput): Promise<ContextArtifactProposal | null> {
    assertUtcDate(input.utc_date);
    const heads = new Set(input.source.lifecycle_heads.map((head) => head.head_event_id));
    const selected = input.source.events
      .filter((event) => heads.has(event.event.event_id))
      .filter((event) => event.event.operation !== "tombstone")
      .filter((event) => event.event.occurred_at.slice(0, 10) === input.utc_date)
      .sort(compareEvents);
    if (selected.length === 0) return null;
    const identities = new Set(selected.map(identity));
    const evidenceEvents = input.source.events
      .filter((event) => identities.has(identity(event)))
      .sort(compareEvents);
    const inputRefs = evidenceEvents.map(referenceFor);
    const items = selected.map((event) => ({
      event_id: event.event.event_id,
      ...(event.thread_id ? { thread_id: event.thread_id } : {}),
      ...(event.actor_id ? { actor_id: event.actor_id } : {}),
      occurred_at: event.event.occurred_at,
      ...(event.text === undefined ? {} : { text: event.text }),
    }));
    const body = {
      schema_version: "1.0",
      utc_date: input.utc_date,
      source_read_epoch: input.source.read_epoch,
      rules_version: this.algorithm_version,
      item_count: items.length,
      items,
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
