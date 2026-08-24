import { arrangeMessage, type ArrangementDecision } from "./arrangement";
import type { EventRecord, IngestRecord } from "./ingestion";
import { surfaceFromParts } from "./message-contract";

export interface ArrangementStore {
  putDisposition(decision: ArrangementDecision): Promise<void>;
}

export class ArrangementService {
  constructor(private readonly store: ArrangementStore) {}

  decide(
    event: EventRecord,
    record: Pick<IngestRecord, "type" | "content" | "weight_hints">,
    now?: string,
  ): ArrangementDecision {
    return arrangeMessage({
      event,
      type: record.type,
      kind: surfaceFromParts(record.content ?? [])?.kind,
      text: bodyText(record),
      weight_hints: record.weight_hints,
      now,
    });
  }

  async remember(
    event: EventRecord,
    record: Pick<IngestRecord, "type" | "content" | "weight_hints">,
    now?: string,
  ): Promise<ArrangementDecision> {
    const decision = this.decide(event, record, now);
    await this.store.putDisposition(decision);
    return decision;
  }
}

function bodyText(
  record: Pick<IngestRecord, "content">,
): string | undefined {
  const part = record.content?.find(
    (item) => item.role === "body" && item.text !== undefined,
  );
  return part?.text;
}
