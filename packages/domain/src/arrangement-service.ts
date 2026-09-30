import { arrangeMessage, type ArrangementDecision } from "./arrangement";
import type { EventRecord, IngestRecord } from "./ingestion";
import { surfaceFromParts } from "./message-contract";
import {
  DEFAULT_PERSONAL_DISPATCH_POLICY,
  PERSONAL_DISPATCH_POLICY_PREF_KEY,
  validatePersonalDispatchPolicy,
  type PersonalDispatchPolicy,
} from "./personal-dispatch-policy";

export interface ArrangementStore {
  putDisposition(decision: ArrangementDecision): Promise<void>;
  getUiPref?(orgId: string, key: string): Promise<string | null>;
}

export class ArrangementService {
  constructor(private readonly store: ArrangementStore) {}

  async policyFor(orgId: string): Promise<PersonalDispatchPolicy> {
    if (!this.store.getUiPref) {
      return DEFAULT_PERSONAL_DISPATCH_POLICY;
    }
    const value = await this.store.getUiPref(orgId, PERSONAL_DISPATCH_POLICY_PREF_KEY);
    if (!value) {
      return DEFAULT_PERSONAL_DISPATCH_POLICY;
    }
    try {
      return validatePersonalDispatchPolicy(JSON.parse(value) as PersonalDispatchPolicy);
    } catch {
      return DEFAULT_PERSONAL_DISPATCH_POLICY;
    }
  }

  decide(
    event: EventRecord,
    record: Pick<IngestRecord, "type" | "content" | "weight_hints">,
    now?: string,
    dispatchPolicy?: PersonalDispatchPolicy,
  ): ArrangementDecision {
    return arrangeMessage({
      event,
      type: record.type,
      kind: surfaceFromParts(record.content ?? [])?.kind,
      text: bodyText(record),
      weight_hints: record.weight_hints,
      dispatch_policy: dispatchPolicy,
      now,
    });
  }

  async remember(
    event: EventRecord,
    record: Pick<IngestRecord, "type" | "content" | "weight_hints">,
    now?: string,
    dispatchPolicy?: PersonalDispatchPolicy,
  ): Promise<ArrangementDecision> {
    const decision = this.decide(event, record, now, dispatchPolicy);
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
