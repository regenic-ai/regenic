import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EMPTY_OVERLAYS,
  indexFollowUps,
  indexProposals,
  proposalErrorKind,
  proposalEvidence,
  proposalRisks,
  withThreadOverlays,
} from "../src/renderer/src/reply-proposals.ts";
import type { CustomerServiceTaskView, PersonalFollowUpView } from "../src/renderer/src/types.ts";

function task(overrides: {
  id: string;
  thread?: string;
  status?: string;
  updated?: string;
  draft?: string;
  unresolved?: string[];
  briefUnresolved?: string[];
}): CustomerServiceTaskView {
  const fact = { value: "", status: "missing" };
  return {
    id: overrides.id,
    status: overrides.status ?? "awaiting_review",
    updated_at: overrides.updated ?? "2026-01-01T00:00:00Z",
    brief: {
      source: { event_id: `e-${overrides.id}`, thread_id: overrides.thread ?? "t1" },
      customer: fact,
      project: fact,
      batch: fact,
      intent: { value: "where is my order", status: "verified" },
      members: [
        { member_key: "m1", display_name: "A" },
        { member_key: "m2", display_name: "B" },
      ],
      unresolved: overrides.briefUnresolved ?? [],
    },
    business_evidence: [
      {
        queried_at: "2026-01-01T00:00:00Z",
        results: [
          { member_key: "m1", status: "found", fields: [] },
          { member_key: "m2", status: "not_found", fields: [] },
        ],
      },
    ],
    draft:
      overrides.draft === undefined
        ? { text: "Shipped today.", covered_member_keys: [], unresolved: overrides.unresolved ?? [] }
        : { text: overrides.draft, covered_member_keys: [], unresolved: overrides.unresolved ?? [] },
  } as unknown as CustomerServiceTaskView;
}

function followUp(id: string, thread: string, due: string): PersonalFollowUpView {
  return { id, candidate: { thread_id: thread, due_at: due } } as unknown as PersonalFollowUpView;
}

describe("reply proposals", () => {
  it("keeps the latest open proposal per thread", () => {
    const index = indexProposals([
      task({ id: "old", updated: "2026-01-01T00:00:00Z" }),
      task({ id: "new", updated: "2026-01-02T00:00:00Z" }),
      task({ id: "sent", thread: "t2", status: "sent" }),
      task({ id: "empty", thread: "t3", draft: "  " }),
    ]);
    assert.equal(index.get("t1")?.id, "new");
    assert.equal(index.has("t2"), false);
    assert.equal(index.has("t3"), false);
  });

  it("keeps the earliest due follow-up per thread", () => {
    const index = indexFollowUps([
      followUp("late", "t1", "2026-01-02T00:00:00Z"),
      followUp("early", "t1", "2026-01-01T00:00:00Z"),
    ]);
    assert.equal(index.get("t1")?.id, "early");
  });

  it("dedupes risks from the draft and the brief", () => {
    const risks = proposalRisks(
      task({ id: "a", unresolved: ["batch unknown", " "], briefUnresolved: ["batch unknown", "no ETA"] }),
    );
    assert.deepEqual(risks, ["batch unknown", "no ETA"]);
  });

  it("summarises evidence coverage", () => {
    assert.deepEqual(proposalEvidence(task({ id: "a" })), {
      members: 2,
      found: 1,
      queriedAt: "2026-01-01T00:00:00Z",
    });
  });

  it("maps send errors to user outcomes", () => {
    assert.equal(proposalErrorKind("context_changed"), "changed");
    assert.equal(proposalErrorKind("business_unavailable"), "unavailable");
    assert.equal(proposalErrorKind("invalid_state"), "stale");
    assert.equal(proposalErrorKind(undefined), "other");
  });

  it("overlays threads without copying when nothing changed", () => {
    const thread = { id: "t1" };
    assert.equal(withThreadOverlays(thread, EMPTY_OVERLAYS), thread);
    const proposal = task({ id: "a" });
    const next = withThreadOverlays(thread, {
      proposals: new Map([["t1", proposal]]),
      followUps: new Map(),
    });
    assert.equal(next.proposal, proposal);
  });
});
