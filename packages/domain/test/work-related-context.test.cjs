const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  WORK_AGENTS_FILENAME,
  WORK_EVIDENCE_RELATED_HINT,
  WORK_EVIDENCE_RELATED_OPEN,
  WORK_RELATED_FILENAME,
  WORK_RELATED_THREAD_LIMIT,
  composeWorkConversation,
  composeWorkspaceInstructionFiles,
  formatRelatedConversations,
  stageConversationWorkspace,
} = require("../dist");

describe("related conversations in work evidence", () => {
  it("formats conversations best match first within the budget", () => {
    const text = formatRelatedConversations([
      {
        channel: "Slack",
        title: "#billing",
        lines: [
          { speaker: "Ann", text: "Refund for order 42 was approved", occurred_at: "2026-10-20T08:00:00.000Z" },
          { speaker: "Bo", text: "Thanks", reply_to: "Ann" },
        ],
      },
      { channel: "Email", lines: [{ speaker: "c@x.io", text: "order 42 shipped" }] },
    ]);
    assert.match(text, /^## Slack · #billing\n/);
    assert.match(text, /Ann.*Refund for order 42 was approved/);
    assert.match(text, /## Email\n/);
    assert.ok(text.indexOf("#billing") < text.indexOf("## Email"));

    const tight = formatRelatedConversations(
      [
        { title: "a", lines: [{ speaker: "x", text: "first" }] },
        { title: "b", lines: [{ speaker: "y", text: "y".repeat(500) }] },
      ],
      60,
    );
    assert.match(tight, /first/);
    assert.equal(tight.includes("## b"), false);

    const many = formatRelatedConversations(
      Array.from({ length: WORK_RELATED_THREAD_LIMIT + 2 }, (_, index) => ({
        title: `t${index}`,
        lines: [{ speaker: "u", text: `m${index}` }],
      })),
    );
    assert.equal(many.split("## ").length - 1, WORK_RELATED_THREAD_LIMIT);
    assert.equal(formatRelatedConversations([]), "");
  });

  it("adds a related section before current and keeps it for workspaces", () => {
    const composed = composeWorkConversation({
      include_context: true,
      trigger_text: "Where is my refund?",
      thread_lines: [
        { speaker: "customer", text: "I ordered #42" },
        { speaker: "customer", text: "Where is my refund?" },
      ],
      related_text: "## Slack · #billing\nAnn: Refund for order 42 was approved",
    });
    assert.equal(composed.related, "## Slack · #billing\nAnn: Refund for order 42 was approved");
    const inline = composed.inline_text;
    assert.ok(inline.includes(WORK_EVIDENCE_RELATED_HINT));
    const at = (tag) => inline.indexOf(`${tag}\n`);
    assert.ok(at("<background>") >= 0);
    assert.ok(at("<background>") < at(WORK_EVIDENCE_RELATED_OPEN));
    assert.ok(at(WORK_EVIDENCE_RELATED_OPEN) < at("<current>"));
    assert.equal(composed.background.includes("Refund for order 42"), false);

    const files = composeWorkspaceInstructionFiles({
      background: composed.background,
      related: composed.related,
    });
    assert.equal(files[WORK_RELATED_FILENAME], composed.related);
    assert.match(files[WORK_AGENTS_FILENAME], /related\.md/);
  });

  it("uses related hits even when the thread has no history", () => {
    const composed = composeWorkConversation({
      include_context: true,
      trigger_text: "Where is my refund?",
      thread_lines: [{ speaker: "customer", text: "Where is my refund?" }],
      related_text: "## Email\nc@x.io: order 42 shipped",
    });
    assert.equal(composed.background, undefined);
    assert.equal(composed.inline_text.includes("<background>\n"), false);
    assert.ok(composed.inline_text.includes(WORK_EVIDENCE_RELATED_OPEN));
    assert.ok(composed.inline_text.includes("<current>"));
  });

  it("leaves evidence unchanged without related hits", () => {
    const base = {
      include_context: true,
      trigger_text: "do it",
      thread_lines: [
        { speaker: "A", text: "history" },
        { speaker: "user", text: "do it" },
      ],
    };
    const plain = composeWorkConversation(base);
    const blank = composeWorkConversation({ ...base, related_text: "  " });
    assert.deepEqual(blank, plain);
    assert.equal("related" in plain, false);
    assert.equal(
      composeWorkConversation({ include_context: false, trigger_text: "x", related_text: "## a\nb" }).inline_text,
      "x",
    );
  });

  it("stages a workspace for related hits alone", async () => {
    let written;
    const staged = await stageConversationWorkspace(
      {
        writeWorkFiles: async (files) => {
          written = files;
          return { cwd: "/tmp/work" };
        },
      },
      { related: "## Email\nc: order 42 shipped" },
      "item-1",
    );
    assert.deepEqual(staged, { cwd: "/tmp/work" });
    assert.equal(written[WORK_RELATED_FILENAME], "## Email\nc: order 42 shipped");
    assert.equal(written[WORK_AGENTS_FILENAME].includes("conversation.md"), false);
  });
});
