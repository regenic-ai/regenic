const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { mapCursorSdkMessages } = require("../dist/cursor-local-client");

describe("mapCursorSdkMessages", () => {
  it("reads SDK Agent.messages.list envelopes, not Cloud Agent user_message rows", () => {
    const mapped = mapCursorSdkMessages([
      {
        type: "user",
        uuid: "u1",
        agent_id: "agent-local-1",
        message: {
          role: "user",
          content: [{ type: "text", text: "Fix the login bug" }],
        },
      },
      {
        type: "assistant",
        uuid: "a1",
        agent_id: "agent-local-1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Looking at auth.ts" }],
        },
      },
    ]);
    assert.deepEqual(mapped, [
      { id: "u1", type: "user_message", text: "Fix the login bug" },
      { id: "a1", type: "assistant_message", text: "Looking at auth.ts" },
    ]);
  });

  it("unpacks local agentConversationTurn steps so pull can see the assistant reply", () => {
    const mapped = mapCursorSdkMessages([
      {
        type: "user",
        uuid: "agent-90c1d4ef-ad4c-4e48-a6bb-bb9ad3baca92:0",
        agent_id: "agent-90c1d4ef-ad4c-4e48-a6bb-bb9ad3baca92",
        message: {
          agentConversationTurn: {
            userMessage: { text: "hi" },
            steps: [
              { thinkingMessage: { text: "The user sent a greeting." } },
              {
                assistantMessage: {
                  text: "你好！有什么我可以帮你的吗？",
                },
              },
            ],
          },
        },
      },
    ]);
    assert.deepEqual(mapped, [
      {
        id: "agent-90c1d4ef-ad4c-4e48-a6bb-bb9ad3baca92.0.user",
        type: "user_message",
        text: "hi",
      },
      {
        id: "agent-90c1d4ef-ad4c-4e48-a6bb-bb9ad3baca92.0.assistant",
        type: "assistant_message",
        text: "你好！有什么我可以帮你的吗？",
      },
    ]);
  });

  it("keeps only the final assistantMessage in a turn, not thinking or progress steps", () => {
    const mapped = mapCursorSdkMessages([
      {
        type: "user",
        uuid: "agent-55d724f2-4685-4cc3-891b-1d860f01941d:0",
        agent_id: "agent-55d724f2-4685-4cc3-891b-1d860f01941d",
        message: {
          agentConversationTurn: {
            userMessage: { text: "帮我看下本机Regenic代码在哪里" },
            steps: [
              { type: "thinking", text: "I should inspect the workspace." },
              {
                type: "assistantMessage",
                message: { text: "我先确认本机工作区与仓库路径，再快速扫一下项目结构。" },
              },
              { type: "toolCall", message: { type: "glob", args: { pattern: "*" } } },
              {
                type: "assistantMessage",
                message: { text: "本机 Regenic 代码在这里：`/Users/bioby/Projects`" },
              },
            ],
          },
        },
      },
    ]);
    assert.deepEqual(
      mapped.map((item) => ({ type: item.type, text: item.text })),
      [
        { type: "user_message", text: "帮我看下本机Regenic代码在哪里" },
        { type: "assistant_message", text: "本机 Regenic 代码在这里：`/Users/bioby/Projects`" },
      ],
    );
  });

  it("drops messages that belong to another local agent", () => {
    const mapped = mapCursorSdkMessages(
      [
        {
          type: "user",
          uuid: "keep",
          agent_id: "agent-aaaa",
          message: { role: "user", content: [{ type: "text", text: "mine" }] },
        },
        {
          type: "user",
          uuid: "other",
          agent_id: "agent-bbbb",
          message: { role: "user", content: [{ type: "text", text: "theirs" }] },
        },
      ],
      "agent-aaaa",
    );
    assert.deepEqual(mapped, [{ id: "keep", type: "user_message", text: "mine" }]);
  });

  it("still reads Cloud Agent conversation nodes", () => {
    const mapped = mapCursorSdkMessages([
      { id: "msg-1", type: "user_message", text: "Add a README" },
    ]);
    assert.deepEqual(mapped, [
      { id: "msg-1", type: "user_message", text: "Add a README" },
    ]);
  });

  it("keeps assistant text from a live run when the store has not persisted yet", () => {
    const { withLiveAssistant, cursorModelSelection } = require("../dist/cursor-local-client");
    const merged = withLiveAssistant(
      [{ id: "u1", type: "user_message", text: "hello" }],
      { id: "run-1", status: "IDLE", assistantText: "Looking now." },
    );
    assert.equal(merged[1].type, "assistant_message");
    assert.equal(merged[1].text, "Looking now.");
    assert.deepEqual(cursorModelSelection("  gpt-5  "), { id: "gpt-5" });
    assert.equal(cursorModelSelection().id, "composer-2.5");
    const streaming = withLiveAssistant(
      [{ id: "u1", type: "user_message", text: "hello" }],
      { id: "run-1", status: "ACTIVE", assistantText: "Looking now." },
    );
    assert.equal(streaming.length, 1);
  });
});
