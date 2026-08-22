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

  it("sends DSH image parts as mediaType + canonical base64 data", async () => {
    const calls = [];
    const egress = new DshSessionEgress(
      {
        async sessionPrompt(input) {
          calls.push(input);
          return { accepted: true, rpc_id: "rpc-2" };
        },
      },
      { installation_id: "dsh-1", session_id: "sess-1" },
    );
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );

    await egress.send({
      installation_id: "dsh-1",
      content: [
        { role: "body", media_type: "text/markdown", text: "Look" },
        {
          role: "attachment",
          media_type: "image/png",
          source_filename: "shot.png",
          bytes: png,
        },
      ],
    });

    assert.deepEqual(calls[0].content, [
      { type: "text", text: "Look" },
      {
        type: "image",
        mimeType: "image/png",
        mediaType: "image/png",
        data: png.toString("base64"),
        name: "shot.png",
      },
    ]);
    assert.equal(calls[0].content[1].url, undefined);
    assert.equal(calls[0].content[1].path, undefined);
  });

  it("normalizes image/jpg to DSH image/jpeg", async () => {
    const calls = [];
    const egress = new DshSessionEgress(
      {
        async sessionPrompt(input) {
          calls.push(input);
          return { accepted: true, rpc_id: "rpc-jpg" };
        },
      },
      { installation_id: "dsh-1", session_id: "sess-1" },
    );

    await egress.send({
      installation_id: "dsh-1",
      content: [
        {
          role: "attachment",
          media_type: "image/jpg",
          source_filename: "shot.jpg",
          bytes: Buffer.from([0xff, 0xd8, 0xff]),
        },
      ],
    });

    assert.equal(calls[0].content[1].mimeType, "image/jpeg");
    assert.equal(calls[0].content[1].mediaType, "image/jpeg");
    assert.equal(calls[0].content[1].name, "shot.jpg");
  });

  it("inlines text attachments into the prompt so remote DSH can read them", async () => {
    const calls = [];
    const egress = new DshSessionEgress(
      {
        async sessionPrompt(input) {
          calls.push(input);
          return { accepted: true, rpc_id: "rpc-txt" };
        },
      },
      { installation_id: "dsh-1", session_id: "sess-1" },
    );

    await egress.send({
      installation_id: "dsh-1",
      content: [
        { role: "body", media_type: "text/plain", text: "Review this" },
        {
          role: "attachment",
          media_type: "text/markdown",
          source_filename: "notes.md",
          bytes: Buffer.from("# Title\n\nDo the thing.", "utf8"),
        },
      ],
    });

    assert.match(calls[0].text, /Attached: notes\.md \(text\/markdown\)/);
    assert.match(calls[0].text, /```markdown\n# Title\n\nDo the thing.\n```/);
    assert.equal(calls[0].content, undefined);
  });

  it("keeps binary files as text mentions, not DSH file/url parts", async () => {
    const calls = [];
    const egress = new DshSessionEgress(
      {
        async sessionPrompt(input) {
          calls.push(input);
          return { accepted: true, rpc_id: "rpc-3" };
        },
      },
      { installation_id: "dsh-1", session_id: "sess-1" },
    );

    await egress.send({
      installation_id: "dsh-1",
      content: [
        { role: "body", media_type: "text/plain", text: "See the spec" },
        {
          role: "attachment",
          media_type: "application/pdf",
          source_filename: "spec.pdf",
          bytes: Buffer.from("%PDF-1.4"),
        },
      ],
    });

    assert.equal(calls[0].text, "See the spec\n\n[Attached: spec.pdf]");
    assert.equal(calls[0].content, undefined);
  });

  it("treats text-labelled files with NUL bytes as binary mentions", async () => {
    const calls = [];
    const egress = new DshSessionEgress(
      {
        async sessionPrompt(input) {
          calls.push(input);
          return { accepted: true, rpc_id: "rpc-nul" };
        },
      },
      { installation_id: "dsh-1", session_id: "sess-1" },
    );

    await egress.send({
      installation_id: "dsh-1",
      content: [
        { role: "body", media_type: "text/plain", text: "Check this" },
        {
          role: "attachment",
          media_type: "text/plain",
          source_filename: "blob.txt",
          bytes: Buffer.from([0x68, 0x69, 0x00, 0x21]),
        },
      ],
    });

    assert.equal(calls[0].text, "Check this\n\n[Attached: blob.txt]");
    assert.equal(calls[0].content, undefined);
  });
});
