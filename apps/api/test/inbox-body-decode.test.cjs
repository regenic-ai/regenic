const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { decodeBodyText, decodeInboxBody } = require("../dist/inbox-body");

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
});
