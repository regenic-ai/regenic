import { arrangeMessage, type ArrangementDecision } from "./arrangement";
import type { EventRecord, IngestRecord } from "./ingestion";

export interface ArrangementStore {
  putDisposition(decision: ArrangementDecision): Promise<void>;
}

export class ArrangementService {
  constructor(private readonly store: ArrangementStore) {}

  async remember(
    event: EventRecord,
    record: Pick<IngestRecord, "type" | "content" | "weight_hints">,
    now?: string,
  ): Promise<ArrangementDecision> {
    const decision = arrangeMessage({
      event,
      type: record.type,
      text: bodyText(record),
      weight_hints: record.weight_hints,
      now,
    });
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
