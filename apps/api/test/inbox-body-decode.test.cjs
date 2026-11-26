const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { applyAttachmentFetch, decodeBodyText, decodeInboxBody } = require("../dist/inbox-body");

describe("inbox body decode", () => {
  it("reads a single-part text blob and a content-parts envelope", () => {
    assert.equal(
      decodeBodyText(Buffer.from("Hello", "utf8"), "text/plain"),
      "Hello",
    );
    const envelope = Buffer.from(
      JSON.stringify([
        {
          role: "body",
          media_type: "text/plain",
          bytes_base64: Buffer.from("Please confirm", "utf8").toString("base64"),
        },
      ]),
      "utf8",
    );
    assert.equal(
      decodeBodyText(envelope, "application/vnd.regenic.content-parts+json"),
      "Please confirm",
    );
    const textEnvelope = Buffer.from(
      JSON.stringify([
        {
          role: "body",
          media_type: "text/plain",
          text: "Hashed body",
        },
      ]),
      "utf8",
    );
    assert.equal(
      decodeBodyText(textEnvelope, "application/vnd.regenic.content-parts+json"),
      "Hashed body",
    );
    const withFile = Buffer.from(
      JSON.stringify([
        {
          role: "body",
          media_type: "text/plain",
          bytes_base64: Buffer.from("Please confirm", "utf8").toString("base64"),
        },
        {
          role: "attachment",
          media_type: "image/png",
          source_filename: "shot.png",
          bytes_base64: Buffer.from("fakepng", "utf8").toString("base64"),
        },
      ]),
      "utf8",
    );
    const meta = decodeInboxBody(
      withFile,
      "application/vnd.regenic.content-parts+json",
      "meta",
    );
    assert.equal(meta.attachments[0].data_base64, undefined);
    assert.equal(meta.attachments[0].filename, "shot.png");
    assert.equal(meta.attachments[0].part_index, 1);
    assert.equal(meta.attachments[0].byte_size, Buffer.from("fakepng", "utf8").byteLength);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Buffer.alloc(2_000_000, 1)]);
    const large = Buffer.from(
      JSON.stringify([
        {
          role: "attachment",
          media_type: "application/octet-stream",
          source_filename: "image.png",
          bytes_base64: png.toString("base64"),
        },
      ]),
      "utf8",
    );
    const preview = decodeInboxBody(
      large,
      "application/vnd.regenic.content-parts+json",
      "preview",
    );
    assert.equal(preview.attachments[0].media_type, "image/png");
    assert.equal(preview.attachments[0].data_base64, png.toString("base64"));
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    const mislabeled = Buffer.from(
      JSON.stringify([
        {
          role: "attachment",
          media_type: "image/png",
          source_filename: "image.png",
          bytes_base64: jpeg.toString("base64"),
        },
      ]),
      "utf8",
    );
    const jpegPreview = decodeInboxBody(
      mislabeled,
      "application/vnd.regenic.content-parts+json",
      "preview",
    );
    assert.equal(jpegPreview.attachments[0].media_type, "image/jpeg");
    assert.equal(jpegPreview.attachments[0].filename, "image.jpg");
    assert.equal(jpegPreview.attachments[0].data_base64, jpeg.toString("base64"));
    const heic = Buffer.alloc(12);
    heic.write("ftyp", 4, "ascii");
    heic.write("heic", 8, "ascii");
    const phone = Buffer.from(
      JSON.stringify([
        {
          role: "attachment",
          media_type: "image/png",
          source_filename: "image.png",
          bytes_base64: heic.toString("base64"),
        },
      ]),
      "utf8",
    );
    const phonePreview = decodeInboxBody(
      phone,
      "application/vnd.regenic.content-parts+json",
      "preview",
    );
    assert.equal(phonePreview.attachments[0].media_type, "image/heic");
    assert.equal(phonePreview.attachments[0].filename, "image.heic");
    assert.equal(phonePreview.attachments[0].data_base64, undefined);
    const surface = decodeInboxBody(
      Buffer.from(
        JSON.stringify({
          channel: "dsh",
          kind: "system",
          direction: "outbound",
          type: "thread_status",
          forwarded_to: {
            thread_id: "dsh:sess-b",
            event_ids: ["ev-1"],
            source: "dsh",
          },
        }),
        "utf8",
      ),
      "application/vnd.regenic.surface+json",
    );
    assert.deepEqual(surface.surface?.forwarded_to, {
      thread_id: "dsh:sess-b",
      event_ids: ["ev-1"],
      source: "dsh",
    });
  });

  it("marks a pointer failed unless its locator is still queued", () => {
    const envelope = Buffer.from(
      JSON.stringify([
        {
          role: "attachment",
          media_type: "application/msword",
          source_filename: "notes.doc",
          external_locator: "feishu:file:file_key",
        },
        {
          role: "attachment",
          media_type: "image/png",
          source_filename: "image.png",
          external_locator: "feishu:image:img_key",
        },
      ]),
      "utf8",
    );
    const body = decodeInboxBody(
      envelope,
      "application/vnd.regenic.content-parts+json",
      "meta",
    );
    const marked = applyAttachmentFetch(
      body,
      new Set(["feishu:image:img_key", "feishu:file:file_key"]),
      new Set(["feishu:image:img_key"]),
    );
    assert.equal(marked.attachments[0].fetch, "available");
    assert.equal(marked.attachments[0].locator, undefined);
    assert.equal(marked.attachments[1].fetch, "syncing");
    assert.equal(marked.attachments[1].filename, "image.png");
    const dropped = applyAttachmentFetch(body, new Set());
    assert.equal(dropped.attachments[0].fetch, "failed");
    assert.equal(dropped.attachments[1].fetch, "failed");
  });
});
