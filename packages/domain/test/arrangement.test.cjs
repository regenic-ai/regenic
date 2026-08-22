const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  arrangeMessage,
  canonicalizeRecordContent,
  IngestionService,
  MemoryAuthorityStore,
  MemoryBlobStore,
  INGEST_SCHEMA_VERSION,
} = require("../dist");

function event(overrides = {}) {
  return {
    id: "event-1",
    org_id: "local-owner",
    source: "slack",
    operation: "create",
    ...overrides,
  };
}

describe("arrangeMessage", () => {
  it("keeps tombstones out of current work", () => {
    const decision = arrangeMessage({
      event: event({ operation: "tombstone" }),
      text: "Please review this",
      now: "2026-08-21T00:00:00.000Z",
    });

    assert.equal(decision.disposition, "outside_current_work");
    assert.deepEqual(decision.reason_codes, ["tombstoned"]);
    assert.equal(decision.layer, "L1_event");
  });

  it("filters acknowledgements as noise", () => {
    const decision = arrangeMessage({
      event: event(),
      text: "thanks",
    });

    assert.equal(decision.disposition, "outside_current_work");
    assert.deepEqual(decision.reason_codes, ["noise"]);
  });

  it("keeps actionable requests in current work", () => {
    const decision = arrangeMessage({
      event: event(),
      type: "thread_reply",
      text: "Can you review the pull request?",
    });

    assert.equal(decision.disposition, "current_work");
    assert.deepEqual(decision.reason_codes, ["actionable"]);
  });

  it("keeps ordinary thread replies out of current work", () => {
    const decision = arrangeMessage({
      event: event(),
      type: "thread_reply",
      text: "I pushed another commit this afternoon.",
    });

    assert.equal(decision.disposition, "outside_current_work");
    assert.deepEqual(decision.reason_codes, ["thread_reply_noise"]);
  });

  it("keeps a short assistant reply in current work", () => {
    const decision = arrangeMessage({
      event: event({ source: "dsh" }),
      kind: "assistant",
      text: "pong",
    });
    assert.equal(decision.disposition, "current_work");
    assert.deepEqual(decision.reason_codes, ["assistant_reply"]);
  });

  it("holds short unclear messages as pending", () => {
    const decision = arrangeMessage({
      event: event(),
      text: "later",
    });

    assert.equal(decision.disposition, "pending");
    assert.deepEqual(decision.reason_codes, ["needs_review"]);
  });

  it("keeps an explicit weight hint even when the text looks like noise", () => {
    const decision = arrangeMessage({
      event: event(),
      text: "ok",
      weight_hints: { importance: 1 },
    });
    assert.equal(decision.disposition, "current_work");
    assert.deepEqual(decision.reason_codes, ["weight_hint"]);
  });

  it("uses weight hints before default personal attention", () => {
    const decision = arrangeMessage({
      event: event(),
      text: "Status update from standup.",
      weight_hints: { urgency: 0.8 },
    });

    assert.equal(decision.disposition, "current_work");
    assert.deepEqual(decision.reason_codes, ["weight_hint"]);
  });

  it("filters Chinese acknowledgements and keeps Chinese requests", () => {
    assert.deepEqual(
      arrangeMessage({ event: event(), text: "收到" }).reason_codes,
      ["noise"],
    );
    assert.deepEqual(
      arrangeMessage({ event: event(), text: "请确认发布" }).reason_codes,
      ["actionable"],
    );
  });
});

describe("IngestionService arrangement", () => {
  it("arranges accepted events and leaves noise out of the inbox", async () => {
    const authorityStore = new MemoryAuthorityStore();
    const service = new IngestionService(new MemoryBlobStore(), authorityStore);

    const accepted = await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "native-local",
      org_id: "local-owner",
      delivery_id: "delivery-1",
      received_at: "2026-08-21T00:00:00.000Z",
      records: [
        {
          operation: "create",
          source: "regenic",
          external_id: "ask-1",
          occurred_at: "2026-08-21T00:00:00.000Z",
          actor: { id: "local-owner" },
          scope: { id: "personal" },
          type: "message",
          content: [{ role: "body", media_type: "text/plain", text: "Please confirm the release." }],
        },
        {
          operation: "create",
          source: "regenic",
          external_id: "ack-1",
          occurred_at: "2026-08-21T00:01:00.000Z",
          actor: { id: "local-owner" },
          scope: { id: "personal" },
          type: "message",
          content: [{ role: "body", media_type: "text/plain", text: "ok" }],
        },
      ],
    });

    const inbox = await authorityStore.listInbox("local-owner");
    assert.equal(accepted.valid, true);
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].event.external_id, "ask-1");
    assert.deepEqual(inbox[0].decision.reason_codes, ["actionable"]);
    assert.equal((await authorityStore.getDisposition(accepted.records[1].event_id)).disposition, "outside_current_work");
  });

  it("drops a source from the inbox when the current head leaves current work", async () => {
    const authorityStore = new MemoryAuthorityStore();
    const service = new IngestionService(new MemoryBlobStore(), authorityStore);
    const record = {
      source: "regenic",
      external_id: "ask-1",
      occurred_at: "2026-08-21T00:00:00.000Z",
      actor: { id: "local-owner" },
      scope: { id: "personal" },
      type: "message",
      content: [{ role: "body", media_type: "text/plain", text: "Please confirm the release." }],
    };

    await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "native-local",
      org_id: "local-owner",
      delivery_id: "delivery-1",
      received_at: "2026-08-21T00:00:00.000Z",
      records: [{ operation: "create", ...record }],
    });
    const revised = await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "native-local",
      org_id: "local-owner",
      delivery_id: "delivery-2",
      received_at: "2026-08-21T00:01:00.000Z",
      records: [{
        operation: "revise",
        ...record,
        occurred_at: "2026-08-21T00:01:00.000Z",
        content: [{ role: "body", media_type: "text/plain", text: "ok" }],
      }],
    });

    assert.equal((await authorityStore.listInbox("local-owner")).length, 0);
    assert.equal(
      (await authorityStore.getDisposition(revised.records[0].event_id)).disposition,
      "outside_current_work",
    );
  });

  it("arranges a duplicate replay when the current head has no disposition", async () => {
    const authorityStore = new MemoryAuthorityStore();
    const blobStore = new MemoryBlobStore();
    const service = new IngestionService(blobStore, authorityStore);
    const record = {
      operation: "create",
      source: "regenic",
      external_id: "ask-1",
      occurred_at: "2026-08-21T00:00:00.000Z",
      actor: { id: "local-owner" },
      scope: { id: "personal" },
      type: "message",
      content: [{ role: "body", media_type: "text/plain", text: "Please confirm the release." }],
    };
    const canonical = canonicalizeRecordContent(record);
    await blobStore.put(canonical.hash, canonical.bytes, canonical.media_type);
    const event = await authorityStore.append({
      org_id: "local-owner",
      source: record.source,
      external_id: record.external_id,
      content_hash: canonical.hash,
      content_media_type: canonical.media_type,
      content_byte_size: canonical.bytes.byteLength,
      occurred_at: record.occurred_at,
      expected_head_id: null,
    });

    const replayed = await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "native-local",
      org_id: "local-owner",
      delivery_id: "delivery-1",
      received_at: "2026-08-21T00:00:00.000Z",
      records: [record],
    });

    assert.equal(replayed.valid, true);
    assert.equal(replayed.records[0].status, "duplicate");
    assert.equal(replayed.records[0].event_id, event.id);
    const inbox = await authorityStore.listInbox("local-owner");
    assert.equal(inbox.length, 1);
    assert.deepEqual(inbox[0].decision.reason_codes, ["actionable"]);
  });
});
