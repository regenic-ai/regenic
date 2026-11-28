import type { EventRecord, WeightHints } from "./ingestion";
import type { MessageKind } from "./message-contract";
import {
  DEFAULT_PERSONAL_DISPATCH_POLICY,
  validatePersonalDispatchPolicy,
  type PersonalDispatchPolicy,
} from "./personal-dispatch-policy";

export type MessageDisposition =
  | "current_work"
  | "outside_current_work"
  | "pending";

export type MessageLayer = "L1_event";

export interface ArrangementDecision {
  event_id: string;
  org_id: string;
  version?: number;
  disposition: MessageDisposition;
  layer: MessageLayer;
  reason_codes: string[];
  score: number;
  decided_at: string;
}

export function sameDispositionContent(
  left: ArrangementDecision,
  right: ArrangementDecision,
): boolean {
  return left.org_id === right.org_id &&
    left.event_id === right.event_id &&
    left.disposition === right.disposition &&
    left.layer === right.layer &&
    left.score === right.score &&
    left.decided_at === right.decided_at &&
    left.reason_codes.length === right.reason_codes.length &&
    left.reason_codes.every((reason, index) => reason === right.reason_codes[index]);
}

export interface InboxDispositionCommand {
  org_id: string;
  event_id: string;
  action: "triage" | "reset" | "reapply_policy" | "work_acked";
  disposition?: MessageDisposition;
  command_id: string;
  issued_at: string;
}

export interface InboxDispositionTransition {
  expected: ArrangementDecision;
  decision: ArrangementDecision;
  command: InboxDispositionCommand;
}

export function sameInboxDispositionCommand(saved: unknown, command: InboxDispositionCommand): boolean {
  if (!saved || typeof saved !== "object") return false;
  const value = saved as Partial<InboxDispositionCommand>;
  return value.org_id === command.org_id
    && value.event_id === command.event_id
    && value.action === command.action
    && value.disposition === command.disposition
    && value.command_id === command.command_id
    && value.issued_at === command.issued_at;
}

export function assertInboxDispositionTransition(input: InboxDispositionTransition): void {
  if (!input || typeof input !== "object" || !input.expected || !input.decision || !input.command) {
    throw new Error("Inbox disposition transition requires an expected snapshot, decision, and command");
  }
  const { expected, decision, command } = input;
  const validDisposition = (value: unknown) =>
    value === "current_work" || value === "outside_current_work" || value === "pending";
  if (
    typeof expected.event_id !== "string" ||
    typeof expected.org_id !== "string" ||
    expected.event_id !== decision.event_id ||
    expected.org_id !== decision.org_id ||
    command.event_id !== expected.event_id ||
    command.org_id !== expected.org_id ||
    !["triage", "reset", "reapply_policy", "work_acked"].includes(command.action) ||
    typeof command.command_id !== "string" ||
    !command.command_id.trim() ||
    command.command_id !== command.command_id.trim() ||
    command.command_id.length > 128 ||
    typeof command.issued_at !== "string" ||
    !Number.isFinite(Date.parse(command.issued_at)) ||
    (command.action === "triage"
      ? !validDisposition(command.disposition)
      : command.disposition !== undefined)
  ) {
    throw new Error("Inbox disposition transition requires matching identity and a valid command");
  }
}

export type InboxDispositionTransitionResult =
  | { outcome: "applied"; decision: ArrangementDecision }
  | { outcome: "replayed"; decision: ArrangementDecision }
  | { outcome: "conflict" }
  | { outcome: "command_conflict" };

export interface InboxItem {
  decision: ArrangementDecision;
  event: EventRecord;
}

export interface ArrangementInput {
  event: Pick<EventRecord, "id" | "org_id" | "source" | "operation">;
  type?: string;
  kind?: MessageKind;
  text?: string;
  weight_hints?: WeightHints;
  dispatch_policy?: PersonalDispatchPolicy;
  now?: string;
}

export function arrangeMessage(input: ArrangementInput): ArrangementDecision {
  const decidedAt = input.now ?? new Date().toISOString();
  const policy = input.dispatch_policy
    ? validatePersonalDispatchPolicy(input.dispatch_policy)
    : DEFAULT_PERSONAL_DISPATCH_POLICY;

  if (input.event.operation === "tombstone") {
    return decision(input, "outside_current_work", ["tombstoned"], 0, decidedAt);
  }

  if (isHighHint(input.weight_hints)) {
    return policyDecision(input, policy.high_hint_disposition, "weight_hint", 0.9, decidedAt);
  }

  if (input.type === "thread_status") {
    return decision(input, "outside_current_work", ["thread_status"], 0.2, decidedAt);
  }

  if (input.type === "task") {
    return decision(input, "current_work", ["task"], 0.88, decidedAt);
  }

  if (input.kind === "assistant") {
    return decision(
      input,
      "outside_current_work",
      ["assistant_not_current_work"],
      0.25,
      decidedAt,
    );
  }

  return policyDecision(
    input,
    policy.default_disposition,
    "default_personal_attention",
    0.6,
    decidedAt,
  );
}

function policyDecision(
  input: ArrangementInput,
  disposition: MessageDisposition,
  defaultReason: string,
  score: number,
  decidedAt: string,
): ArrangementDecision {
  const defaultPolicy = DEFAULT_PERSONAL_DISPATCH_POLICY;
  const defaultDisposition = defaultReason === "weight_hint"
    ? defaultPolicy.high_hint_disposition
    : defaultPolicy.default_disposition;
  return decision(
    input,
    disposition,
    [disposition === defaultDisposition ? defaultReason : `policy_${defaultReason}`],
    score,
    decidedAt,
  );
}

function decision(
  input: ArrangementInput,
  disposition: MessageDisposition,
  reasonCodes: string[],
  score: number,
  decidedAt: string,
): ArrangementDecision {
  return {
    event_id: input.event.id,
    org_id: input.event.org_id,
    disposition,
    layer: "L1_event",
    reason_codes: reasonCodes,
    score,
    decided_at: decidedAt,
  };
}

function isHighHint(hints: WeightHints | undefined): boolean {
  return (hints?.urgency ?? 0) >= 0.7 || (hints?.importance ?? 0) >= 0.7;
}
