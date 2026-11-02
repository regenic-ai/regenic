import type { CustomerServiceTaskView, PersonalFollowUpView } from "./types";

/** Task states where a drafted reply is waiting on the human. */
export const PROPOSAL_STATUSES = ["awaiting_review", "approved"] as const;

export const PROPOSAL_REJECT_REASONS = [
  "wrong_facts",
  "wrong_tone",
  "not_needed",
] as const;
export type ProposalRejectReason = (typeof PROPOSAL_REJECT_REASONS)[number];

/** Stored on the task so the Agent sees why the human declined. */
export const PROPOSAL_REPLY_MYSELF_NOTE = "reply_myself";

export interface ThreadOverlays {
  proposals: ReadonlyMap<string, CustomerServiceTaskView>;
  followUps: ReadonlyMap<string, PersonalFollowUpView>;
}

export const EMPTY_OVERLAYS: ThreadOverlays = {
  proposals: new Map(),
  followUps: new Map(),
};

export function isOpenProposal(task: CustomerServiceTaskView): boolean {
  return (
    (PROPOSAL_STATUSES as readonly string[]).includes(task.status) &&
    Boolean(task.draft?.text.trim()) &&
    Boolean(task.brief.source?.thread_id)
  );
}

/** Latest open proposal per source conversation. */
export function indexProposals(
  tasks: readonly CustomerServiceTaskView[],
): Map<string, CustomerServiceTaskView> {
  const byThread = new Map<string, CustomerServiceTaskView>();
  for (const task of tasks) {
    if (!isOpenProposal(task)) {
      continue;
    }
    const threadId = task.brief.source.thread_id;
    const current = byThread.get(threadId);
    if (!current || current.updated_at < task.updated_at) {
      byThread.set(threadId, task);
    }
  }
  return byThread;
}

export function indexFollowUps(
  items: readonly PersonalFollowUpView[],
): Map<string, PersonalFollowUpView> {
  const byThread = new Map<string, PersonalFollowUpView>();
  for (const item of items) {
    const threadId = item.candidate.thread_id;
    const current = byThread.get(threadId);
    if (!current || current.candidate.due_at > item.candidate.due_at) {
      byThread.set(threadId, item);
    }
  }
  return byThread;
}

export function withThreadOverlays<
  T extends { id: string; proposal?: CustomerServiceTaskView; follow_up?: PersonalFollowUpView },
>(thread: T, overlays: ThreadOverlays): T {
  const proposal = overlays.proposals.get(thread.id);
  const followUp = overlays.followUps.get(thread.id);
  if (proposal === thread.proposal && followUp === thread.follow_up) {
    return thread;
  }
  return { ...thread, proposal, follow_up: followUp };
}

export interface ProposalEvidence {
  members: number;
  found: number;
  queriedAt?: string;
}

export function proposalEvidence(task: CustomerServiceTaskView): ProposalEvidence {
  const results = task.business_evidence.flatMap((page) => page.results);
  const covered = new Set(task.draft?.covered_member_keys ?? []);
  const members = covered.size || task.brief.members.length;
  const found = new Set(
    results
      .filter((result) => result.status === "found")
      .filter((result) => covered.size === 0 || covered.has(result.member_key))
      .map((result) => result.member_key),
  ).size;
  const queriedAt = task.business_evidence
    .map((page) => page.queried_at)
    .sort()
    .at(-1);
  return { members, found, ...(queriedAt ? { queriedAt } : {}) };
}

/** Never folded: anything the draft could not verify. */
export function proposalRisks(task: CustomerServiceTaskView): string[] {
  const risks = new Set<string>();
  for (const item of task.draft?.unresolved ?? []) {
    if (item.trim()) risks.add(item.trim());
  }
  for (const item of task.brief.unresolved) {
    if (item.trim()) risks.add(item.trim());
  }
  return [...risks];
}

export function proposalFacts(
  task: CustomerServiceTaskView,
): Array<{ key: "customer" | "project" | "batch" | "intent"; value: string; verified: boolean }> {
  return (["customer", "project", "batch", "intent"] as const).flatMap((key) => {
    const value = task.brief[key];
    return value.value
      ? [{ key, value: value.value, verified: value.status === "verified" }]
      : [];
  });
}

export function proposalMemberRows(task: CustomerServiceTaskView): Array<{
  key: string;
  name: string;
  status: string;
  fields: string;
}> {
  const results = task.business_evidence.flatMap((page) => page.results);
  return task.brief.members.map((member) => {
    const result = [...results].reverse().find((entry) => entry.member_key === member.member_key);
    return {
      key: member.member_key,
      name: member.display_name,
      status: result?.status ?? "not_queried",
      fields: result?.fields
        .filter((field) => field.visibility === "customer")
        .map((field) => `${field.field}: ${String(field.value)}`)
        .join(" · ") ?? "",
    };
  });
}

export type ProposalErrorKind = "changed" | "unavailable" | "stale" | "other";

export function proposalErrorKind(code: string | undefined): ProposalErrorKind {
  if (code === "context_changed") return "changed";
  if (code === "business_unavailable") return "unavailable";
  if (code === "invalid_state" || code === "review_required" || code === "not_found") {
    return "stale";
  }
  return "other";
}
