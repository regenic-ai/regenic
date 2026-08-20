import type { EventRecord, WeightHints } from "./ingestion";

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
  text?: string;
  weight_hints?: WeightHints;
  now?: string;
}

const NOISE_PATTERN =
  /^(ok|okay|thanks|thx|ty|lol|lgtm|\+1|ha+|嗯+|好的|收到|谢谢|哈哈|👍|🙏)+[!！.。]*$/i;
const ACTIONABLE_PATTERN =
  /[?？]|please|can you|could you|need you|deadline|blocker|urgent|请(帮|看|确认|处理)|帮忙|截止|紧急|阻塞/i;

export function arrangeMessage(input: ArrangementInput): ArrangementDecision {
  const text = normalizeText(input.text);
  const decidedAt = input.now ?? new Date().toISOString();

  if (input.event.operation === "tombstone") {
    return decision(input, "outside_current_work", ["tombstoned"], 0, decidedAt);
  }

  if (isNoise(text)) {
    return decision(input, "outside_current_work", ["noise"], 0, decidedAt);
  }

  if (isHighHint(input.weight_hints)) {
    return decision(input, "current_work", ["weight_hint"], 0.9, decidedAt);
  }

  if (isActionable(text)) {
    return decision(input, "current_work", ["actionable"], 0.85, decidedAt);
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
    return decision(input, "pending", ["needs_review"], 0.4, decidedAt);
  }

  return decision(
    input,
    "current_work",
    ["default_personal_attention"],
    0.6,
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
