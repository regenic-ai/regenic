const assert = require("node:assert/strict");
const { it } = require("node:test");
const { ContextSearcher, contextSearchRequest } = require("../dist");

it("projects bounded Unicode snippets only from the authorized bundle and keeps display-only authority", async () => {
  const request = contextSearchRequest({ query: " launch ", limit: 2 }, {
    id: "request", org_id: "owner", principal: { actor_type: "human", actor_id: "owner" },
  });
  assert.deepEqual(request.allowed_uses, ["display"]);
  assert.equal(request.query, "launch");
  assert.equal(request.budget.max_items, 2);
  const text = `prefix ${"😀".repeat(600)} secret tail`;
  let observed;
  const result = await new ContextSearcher({
    async assemble(input) {
      observed = input;
      return {
        snapshot: { id: "snapshot", read_epoch: "epoch", retrieval_profile_version: "hybrid-v1",
          retrieval_trace: [{ retriever_id: "event-hybrid", mode: "hybrid", generation: "generation",
            authorized_count: 1, covered_count: 1, routes: [{ event_id: "event", start: 7, end: text.length }] }] },
        bundle: { sections: [{ items: [{ kind: "event", resource_id: "event", text, content_hash: "a".repeat(64),
          evidence: [{ event_id: "event", content_hash: "a".repeat(64), source: "source", occurred_at: "time" }] }] }],
          degradation_flags: ["vector_partial"], budget_ledger: { truncated_items: 1 } },
      };
    },
  }).search(request);
  assert.deepEqual(observed, request);
  assert.equal(Array.from(result.items[0].snippet).length, 480);
  assert.equal(result.items[0].snippet, "😀".repeat(480));
  assert.equal(text.slice(result.items[0].snippet_start, result.items[0].snippet_end), result.items[0].snippet);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.degradation_flags, ["vector_partial"]);
  assert.equal(result.generation, "generation");
  assert.equal(JSON.stringify(result).includes("secret tail"), false);
});
