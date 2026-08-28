const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { MemoryAuthorityStore } = require("@regenic/domain");
const { CursorApiError } = require("../dist/cursor-api-client");
const { CursorAgentEgress } = require("../dist/cursor-agent-egress");

describe("CursorAgentEgress", () => {
  it("sends a follow-up run without writing Events", async () => {
    const calls = [];
    const store = new MemoryAuthorityStore();
    const egress = new CursorAgentEgress(
      {
        async createRun(agentId, text) {
          calls.push({ agentId, text });
          return { id: "run-2" };
        },
      },
      { installation_id: "cursor-1", agent_id: "bc-1" },
    );

    const receipt = await egress.send({
      installation_id: "cursor-1",
      content: [{ role: "body", media_type: "text/plain", text: "Also add tests" }],
    });

    assert.deepEqual(calls, [{ agentId: "bc-1", text: "Also add tests" }]);
    assert.deepEqual(receipt, { accepted: true, rpc_id: "run-2" });
    assert.deepEqual(await store.listEvents("local-owner"), []);
  });

  it("rejects a send without text", async () => {
    const egress = new CursorAgentEgress(
      {
        async createRun() {
          throw new Error("should not run");
        },
      },
      { installation_id: "cursor-1", agent_id: "bc-1" },
    );
    await assert.rejects(
      () =>
        egress.send({
          installation_id: "cursor-1",
          content: [{ role: "body", media_type: "text/plain", text: "   " }],
        }),
      CursorApiError,
    );
  });
});
