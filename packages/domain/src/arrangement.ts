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
  disposition: MessageDisposition;
  layer: MessageLayer;
  reason_codes: string[];
  score: number;
  decided_at: string;
}

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

const NOISE_PATTERN =
  /^(ok|okay|thanks|thx|ty|lol|lgtm|\+1|ha+|嗯+|好的|收到|谢谢|哈哈|👍|🙏)+[!！.。]*$/i;
const ACTIONABLE_PATTERN =
  /[?？]|please|can you|could you|need you|deadline|blocker|urgent|请(帮|看|确认|处理)|帮忙|截止|紧急|阻塞/i;

export function arrangeMessage(input: ArrangementInput): ArrangementDecision {
  const text = normalizeText(input.text);
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

  if (isNoise(text)) {
    return decision(input, "outside_current_work", ["noise"], 0, decidedAt);
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

  if (isActionable(text)) {
    return policyDecision(input, policy.actionable_disposition, "actionable", 0.85, decidedAt);
  }

  if (input.type === "thread_reply") {
    return decision(
      input,
      "outside_current_work",
      ["thread_reply_noise"],
      0.15,
      decidedAt,
    );
  }

  if (text !== undefined && text.length < 8) {
    return policyDecision(input, policy.short_text_disposition, "needs_review", 0.4, decidedAt);
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
    : defaultReason === "actionable"
      ? defaultPolicy.actionable_disposition
      : defaultReason === "needs_review"
        ? defaultPolicy.short_text_disposition
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

function normalizeText(text: string | undefined): string | undefined {
  if (text === undefined) {
    return undefined;
  }
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : "";
}

function isNoise(text: string | undefined): boolean {
  return text !== undefined && (text.length === 0 || NOISE_PATTERN.test(text));
}

function isActionable(text: string | undefined): boolean {
  return text !== undefined && ACTIONABLE_PATTERN.test(text);
}

function isHighHint(hints: WeightHints | undefined): boolean {
  return (hints?.urgency ?? 0) >= 0.7 || (hints?.importance ?? 0) >= 0.7;
}
