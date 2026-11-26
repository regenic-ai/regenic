const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { describe, it } = require("node:test");
const {
  ATTACHMENT_OPEN_MAX_BYTES,
  agentContextFileUrl,
  attachmentContentDisposition,
  attachmentThreadAllowed,
  describeStoredFile,
  openEventAttachment,
} = require("../dist/attachment-file");

const ENVELOPE = "application/vnd.regenic.content-parts+json";

describe("attachment files", () => {
  it("builds a loopback address without putting the token in it", () => {
    assert.equal(
      agentContextFileUrl("http://127.0.0.1:4370/v1/agent/context/mcp", "evt/1", 2),
      "http://127.0.0.1:4370/v1/agent/context/files/evt%2F1/2",
    );
  });

  it("keeps a locked run inside one conversation", () => {
    assert.equal(attachmentThreadAllowed({ thread_id: "chat-1" }, "chat-1"), true);
    assert.equal(attachmentThreadAllowed({ thread_id: "chat-2" }, "chat-1"), false);
    assert.equal(attachmentThreadAllowed({ thread_id: "chat-2" }, undefined), true);
  });

  it("refuses an oversized sidecar before reading its bytes", async () => {
    const sidecar = "b".repeat(64);
    const envelopeJson = JSON.stringify([
      { role: "body", media_type: "text/plain", text: "see the sheet" },
      {
        role: "attachment",
        media_type: "application/vnd.ms-excel",
        source_filename: "预算.xlsx",
        content_hash: sidecar,
      },
    ]);
    const envelope = Buffer.from(envelopeJson);
    const envelopeHash = createHash("sha256").update(envelope).digest("hex");
    let sidecarReads = 0;
    const backing = new Map([
      [envelopeHash, { bytes: envelope, media_type: ENVELOPE, byte_size: envelope.byteLength }],
      [sidecar, {
        bytes: Buffer.alloc(4),
        media_type: "application/vnd.ms-excel",
        byte_size: ATTACHMENT_OPEN_MAX_BYTES + 1,
      }],
    ]);
    const authority = {
      async getEvent() {
        return { id: "event-1", content_hash: envelopeHash, thread_id: "chat-1" };
      },
      async findBlob(hash) {
        const found = backing.get(hash);
        if (!found) return null;
        return {
          content_hash: hash,
          media_type: found.media_type,
          byte_size: found.byte_size,
          created_at: "2026-11-25T00:00:00.000Z",
        };
      },
    };
    const blobs = {
      async get(hash) {
        if (hash === sidecar) sidecarReads += 1;
        const found = backing.get(hash);
        if (!found) throw new Error("missing");
        return found.bytes;
      },
    };
    await assert.rejects(
      () => openEventAttachment(authority, blobs, "local", "event-1", 1),
      (error) => error.getResponse().error.code === "file_too_large",
    );
    assert.equal(sidecarReads, 0);
    assert.match(attachmentContentDisposition("预算.xlsx"), /filename\*=UTF-8''/);
  });

  it("adds a suffix from the bytes when the stored name has none", async () => {
    const pdf = Buffer.from("%PDF-1.4");
    const sidecar = createHash("sha256").update(pdf).digest("hex");
    const envelopeJson = JSON.stringify([
      {
        role: "attachment",
        media_type: "application/octet-stream",
        source_filename: "attachment",
        content_hash: sidecar,
      },
    ]);
    const envelope = Buffer.from(envelopeJson);
    const envelopeHash = createHash("sha256").update(envelope).digest("hex");
    const backing = new Map([
      [envelopeHash, { bytes: envelope, media_type: ENVELOPE, byte_size: envelope.byteLength }],
      [sidecar, { bytes: pdf, media_type: "application/octet-stream", byte_size: pdf.byteLength }],
    ]);
    const authority = {
      async getEvent() {
        return { id: "event-1", content_hash: envelopeHash, thread_id: "chat-1" };
      },
      async findBlob(hash) {
        const found = backing.get(hash);
        if (!found) return null;
        return {
          content_hash: hash,
          media_type: found.media_type,
          byte_size: found.byte_size,
          created_at: "2026-11-25T00:00:00.000Z",
        };
      },
    };
    const blobs = {
      async get(hash) {
        const found = backing.get(hash);
        if (!found) throw new Error("missing");
        return found.bytes;
      },
    };
    const opened = await openEventAttachment(authority, blobs, "local", "event-1", 0);
    assert.equal(opened.filename, "attachment.pdf");
    assert.equal(opened.media_type, "application/pdf");
    assert.equal(
      describeStoredFile("attachment", "application/octet-stream", Buffer.from("PK\u0003\u0004word/")).filename,
      "attachment.docx",
    );
  });
});
