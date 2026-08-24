const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  INGEST_SCHEMA_VERSION,
  IngestionService,
  MemoryAuthorityStore,
  MemoryBlobStore,
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
});
