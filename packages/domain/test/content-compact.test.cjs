const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { describe, it } = require("node:test");
const {
  CONTENT_PARTS_MEDIA_TYPE,
  MemoryAuthorityStore,
  MemoryBlobStore,
  compactEmbeddedContent,
  parseStoredContentParts,
} = require("../dist");

describe("compactEmbeddedContent", () => {
  it("rewrites inlined base64 attachments into hashed blobs", async () => {
    const authority = new MemoryAuthorityStore();
    const blobs = new MemoryBlobStore();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 8, 7, 6]);
    const envelope = Buffer.from(
      JSON.stringify([
        {
          role: "body",
          media_type: "text/plain",
          source_filename: null,
          bytes_base64: Buffer.from("see this", "utf8").toString("base64"),
        },
        {
          role: "attachment",
          media_type: "image/png",
          source_filename: "shot.png",
          bytes_base64: png.toString("base64"),
        },
        {
          role: "metadata",
          media_type: "application/vnd.regenic.surface+json",
          source_filename: null,
          bytes_base64: Buffer.from(
            JSON.stringify({
              channel: "feishu",
              kind: "user",
              direction: "inbound",
            }),
            "utf8",
          ).toString("base64"),
        },
      ]),
      "utf8",
    );
    const oldHash = createHash("sha256").update(envelope).digest("hex");
    await blobs.put(oldHash, envelope, CONTENT_PARTS_MEDIA_TYPE);
    const event = await authority.append({
      org_id: "local-owner",
      source: "feishu",
      external_id: "oc_1:om_1",
      content_hash: oldHash,
      content_media_type: CONTENT_PARTS_MEDIA_TYPE,
      content_byte_size: envelope.byteLength,
      occurred_at: "2026-08-27T00:00:00.000Z",
      expected_head_id: null,
    });

    const first = await compactEmbeddedContent(authority, blobs, "local-owner");
    const second = await compactEmbeddedContent(authority, blobs, "local-owner");
    const updated = await authority.getEvent("local-owner", event.id);
    const parts = parseStoredContentParts(await blobs.get(updated.content_hash));
    const attachment = parts.find((part) => part.role === "attachment");
    const body = parts.find((part) => part.role === "body");

    assert.equal(first.rewritten, 1);
    assert.equal(second.rewritten, 0);
    assert.notEqual(updated.content_hash, oldHash);
    assert.equal(await blobs.exists(oldHash), false);
    assert.equal(body.text, "see this");
    assert.equal(attachment.bytes_base64, undefined);
    assert.deepEqual(Buffer.from(await blobs.get(attachment.content_hash)), png);
    assert.ok(first.released_bytes > 0);
  });
});
