const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { MemoryAuthorityStore } = require("@regenic/domain");
const { DshApiError, DshSessionEgress } = require("../dist");

describe("DshSessionEgress", () => {
  it("sends through the transport client without writing Events", async () => {
    const calls = [];
    const store = new MemoryAuthorityStore();
    const egress = new DshSessionEgress(
      {
        async sessionPrompt(input) {
          calls.push(input);
          return { accepted: true, rpc_id: "rpc-1" };
        },
      },
      { installation_id: "dsh-1", session_id: "sess-1" },
    );

    const receipt = await egress.send({
      installation_id: "dsh-1",
      content: [{ role: "body", media_type: "text/plain", text: "Follow up" }],
    });

    assert.deepEqual(calls, [{ sessionId: "sess-1", text: "Follow up" }]);
    assert.deepEqual(receipt, { accepted: true, rpc_id: "rpc-1" });
    assert.deepEqual(await store.listEvents("local-owner"), []);
  });

  it("rejects a send without text/plain content", async () => {
    const egress = new DshSessionEgress(
      {
        async sessionPrompt() {
          throw new Error("should not run");
        },
      },
      { installation_id: "dsh-1", session_id: "sess-1" },
    );
    await assert.rejects(
      () =>
        egress.send({
          installation_id: "dsh-1",
          content: [{ role: "body", media_type: "text/plain", text: "   " }],
        }),
      DshApiError,
    );
  });
});
