const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  INGEST_SCHEMA_VERSION,
  IngestionService,
  MemoryAuthorityStore,
  MemoryBlobStore,
  channelRecord,
} = require("@regenic/domain");
const { resolveInboxBodies } = require("../dist/inbox-body");

describe("resolveInboxBodies", () => {
  it("loads a page of bodies from store batch primitives", async () => {
    const authority = new MemoryAuthorityStore();
    const blobs = new MemoryBlobStore();
    const service = new IngestionService(blobs, authority);
    const ingested = await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "native-local",
      org_id: "local-owner",
      delivery_id: "page-1",
      received_at: "2026-08-24T00:00:00.000Z",
      records: [1, 2].map((index) => ({
        operation: "create",
        source: "feishu",
        external_id: `oc_yiki:om_${index}`,
        occurred_at: `2026-08-24T00:00:0${index}.000Z`,
        actor: { id: "local-owner" },
        scope: { id: "personal" },
        type: "text",
        content: [
          {
            role: "body",
            media_type: "text/plain",
            text: `Thread body ${index}`,
          },
        ],
      })),
    });
    const events = [
      await authority.getEvent("local-owner", ingested.records[0].event_id),
      await authority.getEvent("local-owner", ingested.records[1].event_id),
    ];

    const bodies = await resolveInboxBodies(
      authority,
      blobs,
      [...events.map((event) => event.content_hash), "missing"],
    );

    assert.equal(bodies.size, 3);
    assert.equal(bodies.get(events[0].content_hash).body_text, "Thread body 1");
    assert.equal(bodies.get(events[1].content_hash).body_text, "Thread body 2");
    assert.deepEqual(bodies.get("missing"), {});
  });

  it("loads hashed attachment previews from sidecar blobs", async () => {
    const authority = new MemoryAuthorityStore();
    const blobs = new MemoryBlobStore();
    const service = new IngestionService(blobs, authority);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
    const ingested = await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "feishu-chat",
      org_id: "local-owner",
      delivery_id: "attach-1",
      received_at: "2026-08-27T00:00:00.000Z",
      records: [
        channelRecord({
          channel: "feishu",
          kind: "user",
          direction: "inbound",
          external_id: "oc_1:om_1",
          occurred_at: "2026-08-27T00:00:00.000Z",
          actor_id: "ou_1",
          scope_id: "oc_1",
          text: "see this",
          content: [
            {
              role: "attachment",
              media_type: "image/png",
              source_filename: "shot.png",
              bytes: png,
            },
          ],
        }),
      ],
    });
    const event = await authority.getEvent(
      "local-owner",
      ingested.records[0].event_id,
    );

    const preview = await resolveInboxBodies(authority, blobs, [event.content_hash]);
    const meta = await resolveInboxBodies(
      authority,
      blobs,
      [event.content_hash],
      "meta",
    );

    assert.equal(preview.get(event.content_hash).body_text, "see this");
    assert.equal(preview.get(event.content_hash).attachments[0].filename, "shot.png");
    assert.equal(
      preview.get(event.content_hash).attachments[0].data_base64,
      png.toString("base64"),
    );
    assert.equal(meta.get(event.content_hash).attachments[0].data_base64, undefined);
  });

  it("shows a filename chip when the attachment is still only a pointer", async () => {
    const authority = new MemoryAuthorityStore();
    const blobs = new MemoryBlobStore();
    const service = new IngestionService(blobs, authority);
    const ingested = await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "feishu-chat",
      org_id: "local-owner",
      delivery_id: "attach-pointer",
      received_at: "2026-08-28T00:00:00.000Z",
      records: [
        channelRecord({
          channel: "feishu",
          kind: "user",
          direction: "inbound",
          external_id: "oc_1:om_pointer",
          occurred_at: "2026-08-28T00:00:00.000Z",
          actor_id: "ou_1",
          scope_id: "oc_1",
          content: [
            {
              role: "attachment",
              media_type: "image/png",
              source_filename: "image.png",
              external_locator: "source://image/1",
            },
          ],
        }),
      ],
    });
    const event = await authority.getEvent(
      "local-owner",
      ingested.records[0].event_id,
    );
    const preview = await resolveInboxBodies(authority, blobs, [event.content_hash]);
    const attachment = preview.get(event.content_hash).attachments[0];
    assert.equal(attachment.filename, "image.png");
    assert.equal(attachment.media_type, "image/png");
    assert.equal(attachment.data_base64, undefined);
  });

  it("only inlines the latest few image previews on a thread page", async () => {
    const authority = new MemoryAuthorityStore();
    const blobs = new MemoryBlobStore();
    const service = new IngestionService(blobs, authority);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9]);
    const ingested = await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "feishu-chat",
      org_id: "local-owner",
      delivery_id: "attach-many",
      received_at: "2026-08-27T00:00:00.000Z",
      records: Array.from({ length: 8 }, (_, index) =>
        channelRecord({
          channel: "feishu",
          kind: "user",
          direction: "inbound",
          external_id: `oc_1:om_${index}`,
          occurred_at: `2026-08-27T00:00:0${index}.000Z`,
          actor_id: "ou_1",
          scope_id: "oc_1",
          text: `shot ${index}`,
          content: [
            {
              role: "attachment",
              media_type: "image/png",
              source_filename: `shot-${index}.png`,
              bytes: png,
            },
          ],
        }),
      ),
    });
    const hashes = await Promise.all(
      ingested.records.map((record) =>
        authority.getEvent("local-owner", record.event_id).then((event) => event.content_hash),
      ),
    );
    const preview = await resolveInboxBodies(authority, blobs, hashes);
    const inlined = hashes.filter(
      (hash) => preview.get(hash).attachments[0].data_base64,
    );
    assert.equal(inlined.length, 6);
    assert.equal(preview.get(hashes[0]).attachments[0].data_base64, undefined);
    assert.equal(preview.get(hashes[1]).attachments[0].data_base64, undefined);
    assert.equal(
      preview.get(hashes[7]).attachments[0].data_base64,
      png.toString("base64"),
    );
  });

  it("keeps legacy inline previews when another message on the page uses sidecars", async () => {
    const { createHash } = require("node:crypto");
    const { CONTENT_PARTS_MEDIA_TYPE } = require("@regenic/domain");
    const authority = new MemoryAuthorityStore();
    const blobs = new MemoryBlobStore();
    const service = new IngestionService(blobs, authority);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7]);
    const ingested = await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "feishu-chat",
      org_id: "local-owner",
      delivery_id: "attach-hash",
      received_at: "2026-08-27T00:00:00.000Z",
      records: [
        channelRecord({
          channel: "feishu",
          kind: "user",
          direction: "inbound",
          external_id: "oc_1:om_hash",
          occurred_at: "2026-08-27T00:00:01.000Z",
          actor_id: "ou_1",
          scope_id: "oc_1",
          text: "hashed",
          content: [
            {
              role: "attachment",
              media_type: "image/png",
              source_filename: "new.png",
              bytes: png,
            },
          ],
        }),
      ],
    });
    const hashed = await authority.getEvent(
      "local-owner",
      ingested.records[0].event_id,
    );
    const legacy = Buffer.from(
      JSON.stringify([
        { role: "body", media_type: "text/plain", text: "old shot" },
        {
          role: "attachment",
          media_type: "image/png",
          source_filename: "old.png",
          bytes_base64: png.toString("base64"),
        },
      ]),
    );
    const legacyHash = createHash("sha256").update(legacy).digest("hex");
    await blobs.put(legacyHash, legacy, CONTENT_PARTS_MEDIA_TYPE);
    await authority.append({
      org_id: "local-owner",
      source: "feishu",
      external_id: "oc_1:om_legacy",
      content_hash: legacyHash,
      content_media_type: CONTENT_PARTS_MEDIA_TYPE,
      content_byte_size: legacy.byteLength,
      occurred_at: "2026-08-27T00:00:00.000Z",
      expected_head_id: null,
    });

    const preview = await resolveInboxBodies(authority, blobs, [
      legacyHash,
      hashed.content_hash,
    ]);

    assert.equal(preview.get(legacyHash).body_text, "old shot");
    assert.equal(preview.get(legacyHash).attachments[0].filename, "old.png");
    assert.equal(
      preview.get(legacyHash).attachments[0].data_base64,
      png.toString("base64"),
    );
    assert.equal(
      preview.get(hashed.content_hash).attachments[0].data_base64,
      png.toString("base64"),
    );
  });
});
