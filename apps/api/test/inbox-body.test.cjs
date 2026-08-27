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
});
