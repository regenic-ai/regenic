const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { conversationId } = require("@regenic/domain");
const {
  cursorExternalId,
  isLocalCursorAgentId,
} = require("../dist/cursor-ids");

describe("cursor inbox ids", () => {
  it("keeps local SDK turns on cursor:<agent-uuid>", () => {
    const agentId = "agent-90c1d4ef-ad4c-4e48-a6bb-bb9ad3baca92";
    assert.equal(isLocalCursorAgentId(agentId), true);
    assert.equal(isLocalCursorAgentId(`${agentId}:0`), false);
    assert.equal(isLocalCursorAgentId("bc-1"), false);
    const user = cursorExternalId(agentId, `${agentId}:0:user`);
    const assistant = cursorExternalId(agentId, `${agentId}:0:assistant:1`);
    assert.equal(conversationId("cursor", user), `cursor:${agentId}`);
    assert.equal(conversationId("cursor", assistant), `cursor:${agentId}`);
  });
});
