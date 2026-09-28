import type { MessageDirection, MessageKind, ThreadActivity } from "./message-contract";
import type { EventRecord } from "./ingestion";
import type { PersonalFollowUpPolicy } from "./personal-follow-up-policy";

export interface FollowUpScan {
  thread_id: string;
  external_id: string;
  occurred_at: string;
  direction?: MessageDirection;
  kind?: MessageKind;
  operation?: EventRecord["operation"];
  activity?: ThreadActivity;
}

export interface FollowUpCandidate {
  thread_id: string;
  outbound_external_id: string;
  outbound_at: string;
  due_at: string;
  reason_codes: ["awaiting_reply"];
}

export interface FollowUpSnooze {
  thread_id: string;
  outbound_external_id?: string;
  snoozed_until: string;
}

export function followUpSnoozeKey(threadId: string, outboundExternalId?: string): string {
  return outboundExternalId ? `${threadId}\u0000${outboundExternalId}` : threadId;
}

export function isFollowUpSnoozed(
  snoozes: Readonly<Record<string, string>>,
  candidate: Pick<FollowUpCandidate, "thread_id" | "outbound_external_id">,
  now: string,
): boolean {
  return (
    (snoozes[followUpSnoozeKey(candidate.thread_id, candidate.outbound_external_id)] ?? "") > now
    || (snoozes[candidate.thread_id] ?? "") > now
  );
}

export function collectFollowUpCandidates(input: {
  items: readonly FollowUpScan[];
  policy: PersonalFollowUpPolicy;
  now: string;
}): FollowUpCandidate[] {
  const byThread = new Map<string, FollowUpScan[]>();
  for (const item of input.items) {
    const threadId = item.thread_id.trim();
    if (!threadId || !isFollowUpVisible(item)) {
      continue;
    }
    const items = byThread.get(threadId) ?? [];
    items.push(item);
    byThread.set(threadId, items);
  }
  const candidates: FollowUpCandidate[] = [];
  for (const [threadId, items] of byThread) {
    const ordered = [...items].sort(compareScans);
    const latest = ordered.at(-1);
    if (!latest || latest.direction !== "outbound") {
      continue;
    }
    const hadInbound = ordered.some(
      (item) => item.direction === "inbound" && compareScans(item, latest) < 0,
    );
    if (!input.policy.include_initial_outbound && !hadInbound) {
      continue;
    }
    const dueAt = new Date(
      new Date(latest.occurred_at).getTime() + input.policy.wait_minutes * 60_000,
    );
    if (!Number.isFinite(dueAt.getTime()) || dueAt.toISOString() > input.now) {
      continue;
    }
    candidates.push({
      thread_id: threadId,
      outbound_external_id: latest.external_id,
      outbound_at: latest.occurred_at,
      due_at: dueAt.toISOString(),
      reason_codes: ["awaiting_reply"],
    });
  }
  return candidates.sort((left, right) => left.due_at.localeCompare(right.due_at));
}

function isFollowUpVisible(item: FollowUpScan): boolean {
  return (
    item.operation !== "tombstone" &&
    item.activity !== "working" &&
    item.kind !== "assistant" &&
    item.kind !== "system" &&
    (item.direction === "inbound" || item.direction === "outbound")
  );
}

function compareScans(left: FollowUpScan, right: FollowUpScan): number {
  const byTime = left.occurred_at.localeCompare(right.occurred_at);
  return byTime !== 0 ? byTime : left.external_id.localeCompare(right.external_id);
}