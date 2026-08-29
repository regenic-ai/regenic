const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { createHash } = require("node:crypto");
const {
  INGEST_SCHEMA_VERSION,
  CONTENT_PARTS_MEDIA_TYPE,
  IngestionService,
  MemoryAuthorityStore,
  MemoryBlobStore,
  canonicalizeRecordContent,
  channelRecord,
  parseStoredContentParts,
  storedPartContentHash,
} = require("../dist");

function createBatch(recordOverrides = {}) {
  return {
    schema_version: INGEST_SCHEMA_VERSION,
    connector_id: "native-local",
    org_id: "local-owner",
    delivery_id: "delivery-1",
    received_at: "2026-08-08T00:00:00.000Z",
    records: [
      {
        operation: "create",
        source: "regenic",
        external_id: "source-event-1",
        occurred_at: "2026-08-07T23:59:00.000Z",
        actor: { id: "local-owner" },
        scope: { id: "personal" },
        type: "text",
        content: [
          {
            role: "body",
            media_type: "text/plain",
            text: "Canonical body.\r\nSecond line.",
          },
        ],
        ...recordOverrides,
      },
    ],
  };
}

function createHarness() {
  const blobStore = new MemoryBlobStore();
  const authorityStore = new MemoryAuthorityStore();
  return {
    authorityStore,
    blobStore,
    service: new IngestionService(blobStore, authorityStore),
  };
}

async function seedLegacyEmptyAttachment(authorityStore, blobStore) {
  const empty = new Uint8Array();
  const emptyHash = createHash("sha256").update(empty).digest("hex");
  const envelope = Buffer.from(
    JSON.stringify([
      {
        role: "attachment",
        media_type: "image/png",
        source_filename: "image.png",
        content_hash: emptyHash,
        external_locator: "source://image/1",
      },
    ]),
  );
  const envelopeHash = createHash("sha256").update(envelope).digest("hex");
  await blobStore.put(emptyHash, empty, "image/png");
  await blobStore.put(envelopeHash, envelope, CONTENT_PARTS_MEDIA_TYPE);
  await authorityStore.append({
    org_id: "local-owner",
    source: "regenic",
    external_id: "source-event-1",
    content_hash: envelopeHash,
    content_media_type: CONTENT_PARTS_MEDIA_TYPE,
    content_byte_size: envelope.byteLength,
    extra_blobs: [
      { content_hash: emptyHash, media_type: "image/png", byte_size: 0 },
    ],
    occurred_at: "2026-08-07T23:59:00.000Z",
    expected_head_id: null,
  });
}

describe("IngestionService", () => {
  it("rejects an invalid batch before writing any state", async () => {
    const { authorityStore, blobStore, service } = createHarness();
    const batch = createBatch();
    batch.records[0].occurred_at = "not-a-timestamp";

    const result = await service.ingest(batch);

    assert.equal(result.valid, false);
    assert.equal(result.error_code, "invalid_record");
    assert.equal(authorityStore.allEvents().length, 0);
    assert.equal(blobStore.size, 0);
  });

  it("persists a create and returns its stable Event on replay", async () => {
    const { authorityStore, blobStore, service } = createHarness();
    const batch = createBatch();

    const first = await service.ingest(batch);
    const replay = await service.ingest(batch);

    assert.equal(first.records[0].status, "accepted");
    assert.equal(replay.records[0].status, "duplicate");
    assert.equal(replay.records[0].event_id, first.records[0].event_id);
    assert.equal(authorityStore.allEvents().length, 1);
    assert.equal(blobStore.size, 1);
  });

  it("normalizes text newlines before hashing", async () => {
    const { authorityStore, blobStore, service } = createHarness();
    const first = createBatch();
    const replay = createBatch({
      content: [
        {
          role: "body",
          media_type: "text/plain",
          text: "Canonical body.\nSecond line.",
        },
      ],
    });

    await service.ingest(first);
    const result = await service.ingest(replay);

    assert.equal(result.records[0].status, "duplicate");
    assert.equal(authorityStore.allEvents().length, 1);
    assert.equal(blobStore.size, 1);
  });

  it("revises the same utterance when only actor or direction changed", async () => {
    const { authorityStore, service } = createHarness();
    const inbound = channelRecord({
      channel: "whatsapp-personal",
      kind: "user",
      direction: "inbound",
      external_id: "15558659220652@c.us:3EB0own",
      occurred_at: "2025-07-09T18:58:00.000Z",
      actor_id: "15558659220652@c.us",
      actor_label: "+1 (858) 922-0652",
      scope_id: "15558659220652@c.us",
      text: "Hello, Biobyai here.",
    });
    await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "wa-1",
      org_id: "local-owner",
      delivery_id: "delivery-wa-1",
      received_at: "2026-08-08T00:00:00.000Z",
      records: [inbound],
    });
    const outbound = channelRecord({
      channel: "whatsapp-personal",
      kind: "user",
      direction: "outbound",
      external_id: "15558659220652@c.us:3EB0own",
      occurred_at: "2025-07-09T18:58:00.000Z",
      actor_id: "local-owner",
      scope_id: "15558659220652@c.us",
      text: "Hello, Biobyai here.",
    });
    const revised = await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "wa-1",
      org_id: "local-owner",
      delivery_id: "delivery-wa-2",
      received_at: "2026-08-08T00:01:00.000Z",
      records: [outbound],
    });
    const events = authorityStore.allEvents();
    assert.equal(revised.records[0].status, "accepted");
    assert.equal(events.length, 2);
    assert.equal(events[1].operation, "revise");
    assert.equal(events[1].parent_event_id, events[0].id);
  });

  it("quarantines a conflicting create without writing another Blob", async () => {
    const { authorityStore, blobStore, service } = createHarness();
    await service.ingest(createBatch());

    const result = await service.ingest(
      createBatch({
        content: [
          { role: "body", media_type: "text/plain", text: "Changed body." },
        ],
      }),
    );

    assert.equal(result.records[0].status, "quarantined");
    assert.equal(result.records[0].error_code, "source_identity_conflict");
    assert.equal(authorityStore.allEvents().length, 1);
    assert.equal(blobStore.size, 1);
  });

  it("deduplicates Blob bytes across distinct source identities", async () => {
    const { authorityStore, blobStore, service } = createHarness();

    await service.ingest(createBatch());
    const result = await service.ingest(
      createBatch({ external_id: "source-event-2" }),
    );

    assert.equal(result.records[0].status, "accepted");
    assert.equal(authorityStore.allEvents().length, 2);
    assert.equal(blobStore.size, 1);
  });

  it("isolates identical source IDs by authority boundary", async () => {
    const { authorityStore, blobStore, service } = createHarness();

    await service.ingest(createBatch());
    const otherOwnerBatch = createBatch();
    otherOwnerBatch.org_id = "other-local-owner";
    const result = await service.ingest(otherOwnerBatch);

    assert.equal(result.records[0].status, "accepted");
    assert.equal(authorityStore.allEvents().length, 2);
    assert.equal(blobStore.size, 1);
  });

  it("appends a revision linked to the previous Event", async () => {
    const { authorityStore, blobStore, service } = createHarness();
    const created = await service.ingest(createBatch());

    const revised = await service.ingest(
      createBatch({
        operation: "revise",
        revision_id: "revision-2",
        content: [
          { role: "body", media_type: "text/plain", text: "Revised body." },
        ],
      }),
    );
    const events = authorityStore.allEvents();

    assert.equal(revised.records[0].status, "accepted");
    assert.equal(events.length, 2);
    assert.equal(events[1].operation, "revise");
    assert.equal(events[1].parent_event_id, created.records[0].event_id);
    assert.equal(blobStore.size, 2);
  });

  it("tombstones an Event without deleting its Blob", async () => {
    const { authorityStore, blobStore, service } = createHarness();
    await service.ingest(createBatch());

    const tombstoned = await service.ingest(
      createBatch({ operation: "tombstone", content: undefined }),
    );
    const replay = await service.ingest(
      createBatch({ operation: "tombstone", content: undefined }),
    );

    assert.equal(tombstoned.records[0].status, "accepted");
    assert.equal(replay.records[0].status, "duplicate");
    assert.equal(authorityStore.allEvents().length, 2);
    assert.equal(blobStore.size, 1);
  });

  it("does not revive a tombstoned identity with different content", async () => {
    const { authorityStore, blobStore, service } = createHarness();
    await service.ingest(createBatch());
    await service.ingest(
      createBatch({ operation: "tombstone", content: undefined }),
    );

    const result = await service.ingest(
      createBatch({
        content: [
          { role: "body", media_type: "text/plain", text: "Changed body." },
        ],
      }),
    );

    assert.equal(result.records[0].status, "quarantined");
    assert.equal(result.records[0].error_code, "source_identity_conflict");
    assert.equal(authorityStore.allEvents().length, 2);
    assert.equal(blobStore.size, 1);
  });

  it("keeps a create tombstoned when deletion arrives first", async () => {
    const { authorityStore, blobStore, service } = createHarness();
    const tombstone = createBatch({ operation: "tombstone", content: undefined });
    const create = createBatch();

    await service.ingest(tombstone);
    const created = await service.ingest(create);
    const replay = await service.ingest(create);
    const events = authorityStore.allEvents();

    assert.equal(created.records[0].status, "accepted");
    assert.equal(events.at(-1).operation, "tombstone");
    assert.equal(replay.records[0].status, "duplicate");
    assert.equal(authorityStore.allEvents().length, 3);
    assert.equal(blobStore.size, 1);
  });

  it("accepts an attachment pointer without bytes", async () => {
    const { authorityStore, blobStore, service } = createHarness();
    const result = await service.ingest(
      createBatch({
        content: [
          {
            role: "attachment",
            media_type: "application/pdf",
            source_filename: "doc.pdf",
            external_locator: "source://document/1",
          },
        ],
      }),
    );

    assert.equal(result.records[0].status, "accepted");
    assert.equal(authorityStore.allEvents().length, 1);
    assert.equal(blobStore.size, 1);
  });

  it("fills a pointer with bytes on the same identity and refuses to overwrite them", async () => {
    const { authorityStore, blobStore, service } = createHarness();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const pointer = await service.ingest(
      createBatch({
        content: [
          {
            role: "attachment",
            media_type: "image/png",
            source_filename: "shot.png",
            external_locator: "source://image/1",
          },
        ],
      }),
    );
    const filled = await service.ingest(
      createBatch({
        content: [
          {
            role: "attachment",
            media_type: "image/png",
            source_filename: "shot.png",
            external_locator: "source://image/1",
            bytes: png,
          },
        ],
      }),
    );
    const emptied = await service.ingest(
      createBatch({
        operation: "revise",
        content: [
          {
            role: "attachment",
            media_type: "image/png",
            source_filename: "shot.png",
            external_locator: "source://image/1",
          },
        ],
      }),
    );
    const junk = await service.ingest(
      createBatch({
        operation: "revise",
        content: [
          {
            role: "attachment",
            media_type: "image/png",
            source_filename: "shot.png",
            external_locator: "source://image/1",
            bytes: Buffer.from(JSON.stringify({ error: "token" })),
          },
        ],
      }),
    );

    assert.equal(pointer.records[0].status, "accepted");
    assert.equal(filled.records[0].status, "accepted");
    assert.equal(emptied.records[0].status, "duplicate");
    assert.equal(junk.records[0].status, "duplicate");
    assert.equal(authorityStore.allEvents().length, 2);
  });

  it("fills a legacy empty-byte attachment hash on the same identity", async () => {
    const { authorityStore, blobStore, service } = createHarness();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await seedLegacyEmptyAttachment(authorityStore, blobStore);
    const filled = await service.ingest(
      createBatch({
        content: [
          {
            role: "attachment",
            media_type: "image/png",
            source_filename: "shot.png",
            external_locator: "source://image/1",
            bytes: png,
          },
        ],
      }),
    );
    const events = authorityStore.allEvents();
    const stored = await blobStore.get(events.at(-1).content_hash);
    const parts = parseStoredContentParts(stored);
    const attachment = parts.find((part) => part.role === "attachment");

    assert.equal(filled.records[0].status, "accepted");
    assert.equal(events.length, 2);
    assert.equal(events[1].operation, "revise");
    assert.notEqual(
      storedPartContentHash(attachment),
      createHash("sha256").update(new Uint8Array()).digest("hex"),
    );
    assert.deepEqual(Array.from(await blobStore.get(attachment.content_hash)), Array.from(png));
  });

  it("keeps the first filled image when a later revise brings the second", async () => {
    const { authorityStore, blobStore, service } = createHarness();
    const first = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]);
    const second = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 2]);
    await service.ingest(
      createBatch({
        content: [
          {
            role: "attachment",
            media_type: "image/png",
            source_filename: "a.png",
            external_locator: "source://image/a",
          },
          {
            role: "attachment",
            media_type: "image/png",
            source_filename: "b.png",
            external_locator: "source://image/b",
          },
        ],
      }),
    );
    await service.ingest(
      createBatch({
        operation: "revise",
        content: [
          {
            role: "attachment",
            media_type: "image/png",
            source_filename: "a.png",
            external_locator: "source://image/a",
            bytes: first,
          },
          {
            role: "attachment",
            media_type: "image/png",
            source_filename: "b.png",
            external_locator: "source://image/b",
          },
        ],
      }),
    );
    const filled = await service.ingest(
      createBatch({
        operation: "revise",
        content: [
          {
            role: "attachment",
            media_type: "image/png",
            source_filename: "a.png",
            external_locator: "source://image/a",
          },
          {
            role: "attachment",
            media_type: "image/png",
            source_filename: "b.png",
            external_locator: "source://image/b",
            bytes: second,
          },
        ],
      }),
    );
    const stored = await blobStore.get(authorityStore.allEvents().at(-1).content_hash);
    const hashes = parseStoredContentParts(stored)
      .filter((part) => part.role === "attachment")
      .map((part) => storedPartContentHash(part));

    assert.equal(filled.records[0].status, "accepted");
    assert.equal(hashes.length, 2);
    assert.deepEqual(Array.from(await blobStore.get(hashes[0])), Array.from(first));
    assert.deepEqual(Array.from(await blobStore.get(hashes[1])), Array.from(second));
  });

  it("treats a DSH history echo as the same utterance as a local outbound", async () => {
    const { authorityStore, service } = createHarness();
    const outbound = await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "dsh-session",
      org_id: "local-owner",
      delivery_id: "out-1",
      received_at: "2026-08-21T00:00:00.000Z",
      records: [
        channelRecord({
          channel: "dsh",
          kind: "user",
          direction: "outbound",
          external_id: "session-x:out:rpc-1",
          occurred_at: "2026-08-21T00:00:00.000Z",
          actor_id: "local-owner",
          scope_id: "session-x",
          text: "你是哪个模型",
        }),
      ],
    });
    const echoed = await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "dsh-session",
      org_id: "local-owner",
      delivery_id: "sync-1",
      received_at: "2026-08-21T00:00:02.000Z",
      records: [
        channelRecord({
          channel: "dsh",
          kind: "user",
          direction: "outbound",
          external_id: "session-x:57",
          occurred_at: "2026-08-21T00:00:01.000Z",
          actor_id: "user",
          scope_id: "session-x",
          text: "你是哪个模型",
        }),
      ],
    });

    assert.equal(outbound.records[0].status, "accepted");
    assert.equal(echoed.records[0].status, "duplicate");
    assert.equal(echoed.records[0].event_id, outbound.records[0].event_id);
    assert.equal(authorityStore.allEvents().length, 1);
  });

  it("commits a page of creates and arranges them together", async () => {
    const { authorityStore, blobStore, service } = createHarness();
    const batch = {
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "native-local",
      org_id: "local-owner",
      delivery_id: "page-1",
      received_at: "2026-08-24T00:00:00.000Z",
      records: [1, 2, 3].map((index) => ({
        operation: "create",
        source: "regenic",
        external_id: `oc_yiki:om_${index}`,
        occurred_at: `2026-08-24T00:00:0${index}.000Z`,
        actor: { id: "local-owner" },
        scope: { id: "personal" },
        type: "text",
        content: [
          {
            role: "body",
            media_type: "text/plain",
            text: `Please confirm page ${index}.`,
          },
        ],
      })),
    };

    const result = await service.ingest(batch);
    const events = authorityStore.allEvents();

    assert.equal(result.valid, true);
    assert.deepEqual(
      result.records.map((record) => record.status),
      ["accepted", "accepted", "accepted"],
    );
    assert.equal(events.length, 3);
    assert.equal(blobStore.size, 3);
    assert.equal((await authorityStore.listInbox("local-owner")).length, 3);
    for (const event of events) {
      const decision = await authorityStore.getDisposition(event.id);
      assert.equal(decision?.disposition, "current_work");
      assert.deepEqual(decision?.reason_codes, ["actionable"]);
    }
  });

  it("treats an echo in the same page as the local outbound", async () => {
    const { authorityStore, service } = createHarness();
    const result = await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "dsh-session",
      org_id: "local-owner",
      delivery_id: "mixed-1",
      received_at: "2026-08-21T00:00:02.000Z",
      records: [
        channelRecord({
          channel: "dsh",
          kind: "user",
          direction: "outbound",
          external_id: "session-x:out:rpc-1",
          occurred_at: "2026-08-21T00:00:00.000Z",
          actor_id: "local-owner",
          scope_id: "session-x",
          text: "你是哪个模型",
        }),
        channelRecord({
          channel: "dsh",
          kind: "user",
          direction: "outbound",
          external_id: "session-x:57",
          occurred_at: "2026-08-21T00:00:01.000Z",
          actor_id: "user",
          scope_id: "session-x",
          text: "你是哪个模型",
        }),
      ],
    });

    assert.equal(result.records[0].status, "accepted");
    assert.equal(result.records[1].status, "duplicate");
    assert.equal(result.records[1].event_id, result.records[0].event_id);
    assert.equal(authorityStore.allEvents().length, 1);
  });

  it("treats a Feishu image history echo as the same send as a local outbound", async () => {
    const { authorityStore, service } = createHarness();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    const outbound = await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "feishu-chat",
      org_id: "local-owner",
      delivery_id: "feishu-out-1",
      received_at: "2026-08-26T00:15:00.000Z",
      records: [
        channelRecord({
          channel: "feishu",
          kind: "user",
          direction: "outbound",
          external_id: "oc_1:out:om_text",
          occurred_at: "2026-08-26T00:15:00.000Z",
          actor_id: "local-owner",
          scope_id: "oc_1",
          text: "这块初步好了。",
          content: [
            {
              role: "attachment",
              media_type: "image/png",
              source_filename: "rules.png",
              bytes: png,
            },
          ],
        }),
      ],
    });
    const echoed = await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "feishu-chat",
      org_id: "local-owner",
      delivery_id: "feishu-sync-1",
      received_at: "2026-08-26T00:15:02.000Z",
      records: [
        channelRecord({
          channel: "feishu",
          kind: "user",
          direction: "outbound",
          external_id: "oc_1:om_text",
          occurred_at: "2026-08-26T00:15:00.000Z",
          actor_id: "ou_1",
          actor_label: "李必琪",
          scope_id: "oc_1",
          text: "这块初步好了。",
        }),
        channelRecord({
          channel: "feishu",
          kind: "user",
          direction: "outbound",
          external_id: "oc_1:om_image",
          occurred_at: "2026-08-26T00:15:01.000Z",
          actor_id: "ou_1",
          actor_label: "李必琪",
          scope_id: "oc_1",
          content: [
            {
              role: "attachment",
              media_type: "image/png",
              source_filename: "image.png",
              bytes: png,
            },
          ],
        }),
      ],
    });

    assert.equal(outbound.records[0].status, "accepted");
    assert.equal(echoed.records[0].status, "duplicate");
    assert.equal(echoed.records[1].status, "duplicate");
    assert.equal(echoed.records[0].event_id, outbound.records[0].event_id);
    assert.equal(echoed.records[1].event_id, outbound.records[0].event_id);
    assert.equal(authorityStore.allEvents().length, 1);
  });

  it("does not treat someone else's same image as an outbound echo", async () => {
    const { authorityStore, service } = createHarness();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 8, 7, 6]);
    await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "feishu-chat",
      org_id: "local-owner",
      delivery_id: "feishu-out-2",
      received_at: "2026-08-26T00:16:00.000Z",
      records: [
        channelRecord({
          channel: "feishu",
          kind: "user",
          direction: "outbound",
          external_id: "oc_1:out:om_mine",
          occurred_at: "2026-08-26T00:16:00.000Z",
          actor_id: "local-owner",
          scope_id: "oc_1",
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
    const inbound = await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "feishu-chat",
      org_id: "local-owner",
      delivery_id: "feishu-in-2",
      received_at: "2026-08-26T00:16:03.000Z",
      records: [
        channelRecord({
          channel: "feishu",
          kind: "user",
          direction: "inbound",
          external_id: "oc_1:om_theirs",
          occurred_at: "2026-08-26T00:16:02.000Z",
          actor_id: "ou_2",
          scope_id: "oc_1",
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

    assert.equal(inbound.records[0].status, "accepted");
    assert.equal(authorityStore.allEvents().length, 2);
  });

  it("treats an image-only echo in the same page as the local outbound", async () => {
    const { authorityStore, service } = createHarness();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 4, 3, 2, 1]);
    const result = await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "feishu-chat",
      org_id: "local-owner",
      delivery_id: "feishu-mixed-1",
      received_at: "2026-08-26T00:17:00.000Z",
      records: [
        channelRecord({
          channel: "feishu",
          kind: "user",
          direction: "outbound",
          external_id: "oc_1:out:om_image",
          occurred_at: "2026-08-26T00:17:00.000Z",
          actor_id: "local-owner",
          scope_id: "oc_1",
          content: [
            {
              role: "attachment",
              media_type: "image/png",
              source_filename: "shot.png",
              bytes: png,
            },
          ],
        }),
        channelRecord({
          channel: "feishu",
          kind: "user",
          direction: "outbound",
          external_id: "oc_1:om_image",
          occurred_at: "2026-08-26T00:17:01.000Z",
          actor_id: "ou_1",
          scope_id: "oc_1",
          content: [
            {
              role: "attachment",
              media_type: "image/png",
              source_filename: "image.png",
              bytes: png,
            },
          ],
        }),
      ],
    });

    assert.equal(result.records[0].status, "accepted");
    assert.equal(result.records[1].status, "duplicate");
    assert.equal(result.records[1].event_id, result.records[0].event_id);
    assert.equal(authorityStore.allEvents().length, 1);
  });

  it("stores attachments as hashed blobs instead of inlining base64", async () => {
    const { authorityStore, blobStore, service } = createHarness();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    const first = await service.ingest({
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
    const second = await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "feishu-chat",
      org_id: "local-owner",
      delivery_id: "attach-2",
      received_at: "2026-08-27T00:00:01.000Z",
      records: [
        channelRecord({
          channel: "feishu",
          kind: "user",
          direction: "inbound",
          external_id: "oc_1:om_2",
          occurred_at: "2026-08-27T00:00:01.000Z",
          actor_id: "ou_1",
          scope_id: "oc_1",
          text: "again",
          content: [
            {
              role: "attachment",
              media_type: "image/png",
              source_filename: "copy.png",
              bytes: png,
            },
          ],
        }),
      ],
    });

    assert.equal(first.records[0].status, "accepted");
    assert.equal(second.records[0].status, "accepted");
    assert.equal(authorityStore.allEvents().length, 2);
    assert.equal(blobStore.size, 3);
    const firstHash = authorityStore.allEvents()[0].content_hash;
    const envelope = JSON.parse(Buffer.from(await blobStore.get(firstHash)).toString("utf8"));
    const attachment = envelope.find((part) => part.role === "attachment");
    const body = envelope.find((part) => part.role === "body");
    assert.equal(body.text, "see this");
    assert.equal(attachment.bytes_base64, undefined);
    assert.match(attachment.content_hash, /^[a-f0-9]{64}$/);
    assert.deepEqual(Buffer.from(await blobStore.get(attachment.content_hash)), png);
  });

  it("reads stored blobs in one getMany call", async () => {
    const { blobStore, service } = createHarness();
    const batch = createBatch();
    await service.ingest(batch);
    const hash = canonicalizeRecordContent(batch.records[0]).hash;
    const stored = await blobStore.getMany(["missing", hash, hash]);
    assert.equal(stored.size, 1);
    assert.equal(stored.has("missing"), false);
    assert.deepEqual(stored.get(hash), await blobStore.get(hash));
  });
});