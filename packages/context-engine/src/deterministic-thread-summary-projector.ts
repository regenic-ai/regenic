import { createHash } from "node:crypto";
import {
  canonicalContextJson,
  hashContextArtifactInputs,
  type ContextArtifactProposal,
  type ContextProjector,
  type ContextProjectionCapabilities,
  type ContextProjectionInput,
  type ContextSourceEvent,
} from "@regenic/domain";

export const DETERMINISTIC_THREAD_SUMMARY_ALGORITHM = "thread-summary-deterministic-v1";

export class DeterministicThreadSummaryProjector implements ContextProjector {
  readonly id = "thread-summary-deterministic";
  readonly algorithm_version = DETERMINISTIC_THREAD_SUMMARY_ALGORITHM;

  capabilities(): ContextProjectionCapabilities {
    return {
      artifact_kinds: ["thread_summary"],
      incremental: true,
      rebuild: true,
      requires_model: false,
    };
  }

  async project(input: ContextProjectionInput): Promise<ContextArtifactProposal[]> {
    const heads = new Set(input.lifecycle_heads.map((head) => head.head_event_id));
    const byThread = new Map<string, ContextSourceEvent[]>();
    for (const event of input.source_events) {
      if (!event.thread_id || !event.actor_id || event.required_scope_ids.length === 0) {
        continue;
      }
      const values = byThread.get(event.thread_id) ?? [];
      values.push(event);
      byThread.set(event.thread_id, values);
    }
    const proposals: ContextArtifactProposal[] = [];
    for (const [threadId, events] of [...byThread].sort(([left], [right]) => left.localeCompare(right))) {
      const ordered = [...events].sort(compareSourceEvents);
      const inputRefs = ordered.map((value) => ({
        event_id: value.event.event_id,
        source: value.event.source,
        external_id: value.event.external_id,
        operation: value.event.operation,
        occurred_at: value.event.occurred_at,
        ...(value.event.content_hash ? { content_hash: value.event.content_hash } : {}),
      }));
      const current = ordered.filter((value) => heads.has(value.event.event_id));
      const messages = current
        .filter((value) => value.event.operation !== "tombstone" && value.text !== undefined)
        .map((value) => ({
          event_id: value.event.event_id,
          actor_id: value.actor_id!,
          occurred_at: value.event.occurred_at,
          text: value.text!,
        }));
      const body = {
        schema_version: "1.0",
        thread_id: threadId,
        message_count: messages.length,
        participant_ids: [...new Set(messages.map((message) => message.actor_id))].sort(),
        ...(messages[0] ? { started_at: messages[0].occurred_at } : {}),
        ...(messages.at(-1) ? { ended_at: messages.at(-1)!.occurred_at } : {}),
        messages,
      };
      const inputHash = hashContextArtifactInputs({ input_refs: inputRefs });
      const bodyHash = sha256(canonicalContextJson(body));
      proposals.push({
        id: `thread-summary:${sha256(canonicalContextJson([input.org_id, threadId, input.generation, inputHash]))}`,
        org_id: input.org_id,
        kind: "thread_summary",
        schema_version: "1.0",
        algorithm_version: this.algorithm_version,
        generation: input.generation,
        input_refs: inputRefs,
        input_hash: inputHash,
        body_hash: bodyHash,
        status: "proposed",
        required_scope_ids: [...new Set(ordered.flatMap((value) => value.required_scope_ids))].sort(),
        recorded_at: input.recorded_at,
        attrs: body,
      });
    }
    return proposals;
  }
}

function compareSourceEvents(left: ContextSourceEvent, right: ContextSourceEvent): number {
  return left.event.ingested_at.localeCompare(right.event.ingested_at)
    || left.event.event_id.localeCompare(right.event.event_id);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}