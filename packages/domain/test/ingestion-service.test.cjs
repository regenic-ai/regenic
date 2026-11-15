const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { createHash } = require("node:crypto");
const {
  INGEST_SCHEMA_VERSION,
  CONTENT_PARTS_MEDIA_TYPE,
  AuthorityConflictError,
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

describe("MemoryBlobStore", () => {
  it("enumerates visible objects with deterministic byte sizes", async () => {
    const blobs = new MemoryBlobStore();
    const legacy = Buffer.from("legacy");
    const legacyHash = createHash("sha256").update(legacy).digest("hex");
    const fenced = Buffer.from("fenced");
    const fencedHash = createHash("sha256").update(fenced).digest("hex");
    const deleted = Buffer.from("deleted");
    const deletedHash = createHash("sha256").update(deleted).digest("hex");
    await blobs.put(legacyHash, legacy, "text/plain");
    await blobs.putFenced(fencedHash, fenced, "text/plain", 1);
    await blobs.putFenced(deletedHash, deleted, "text/plain", 1);
    await blobs.deleteFenced(deletedHash, 2);

    const entries = [];
    for await (const entry of blobs.enumerate()) entries.push(entry);
    const expected = [
      { hash: legacyHash, byte_size: legacy.byteLength },
      { hash: fencedHash, byte_size: fenced.byteLength },
    ].sort((left, right) => left.hash.localeCompare(right.hash));
    assert.deepEqual(entries, expected);
  });
});

describe("MemoryAuthorityStore Blob inventory", () => {
  it("keeps inventory entries protected when the in-memory reference ledger is incomplete", async () => {
    const authority = new MemoryAuthorityStore();
    const bytes = Buffer.from("memory blob");
    const hash = createHash("sha256").update(bytes).digest("hex");
    await authority.reserveBlobWrites({
      owner_id: "inventory-test",
      lease_duration_ms: 60_000,
      blobs: [{
        content_hash: hash,
        media_type: "text/plain",
        byte_size: bytes.byteLength,
      }],
    });

    const inventory = await authority.inspectBlobInventory([hash]);
    assert.equal(inventory.get(hash).state, "protected");
    assert.equal(inventory.get(hash).reference_count, 0);
    assert.equal(inventory.get(hash).unreferenced_at, null);
  });
});

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
  it("commits a content-free tombstone without an existing memory source head", async () => {
    const authorityStore = new MemoryAuthorityStore();
    const [event] = await authorityStore.commitIngest({
      appends: [{
        id: "missing-tombstone", org_id: "local-owner", source: "regenic",
        external_id: "missing", operation: "tombstone",
        occurred_at: "2026-08-08T00:00:00.000Z", expected_head_id: null,
      }],
      dispositions: [],
    });
    assert.equal(event.operation, "tombstone");
    assert.equal(event.content_hash, undefined);
    assert.equal(event.parent_event_id, undefined);
    assert.equal((await authorityStore.findBySourceIdentity({
      org_id: "local-owner", source: "regenic", external_id: "missing",
    })).id, event.id);
  });

  it("uses the committed head after a mixed page flushes pending creates", async () => {
    const { authorityStore, service } = createHarness();
    const batch = createBatch();
    const original = batch.records[0];
    batch.records.push(
      { ...original, operation: "revise", content: [{ role: "body", media_type: "text/plain", text: "Revised" }] },
      { ...original, operation: "revise" },
    );
    const result = await service.ingest(batch);
    assert.deepEqual(result.records.map((record) => record.status), ["accepted", "accepted", "accepted"]);
    assert.equal(authorityStore.allEvents().length, 3);
    const head = await authorityStore.findBySourceIdentity({
      org_id: batch.org_id, source: original.source, external_id: original.external_id,
    });
    assert.equal(head.id, result.records[2].event_id);
    assert.equal(head.parent_event_id, result.records[1].event_id);
  });

  it("fails the whole intake when a create loses a source-head race", async () => {
    const { authorityStore, service } = createHarness();
    const commit = authorityStore.commitConversationIntake.bind(authorityStore);
    let injected = false;
    authorityStore.commitConversationIntake = async (request) => {
      if (!injected) {
        injected = true;
        const eventId = "concurrent-event";
        await authorityStore.commitIngest({
          appends: [{ ...request.ingest.appends[0], id: eventId }],
          dispositions: [{ ...request.ingest.dispositions[0], event_id: eventId }],
        });
        throw new AuthorityConflictError();
      }
      return commit(request);
    };
    const batch = createBatch();
    batch.records.push({ ...batch.records[0] });
    await assert.rejects(service.ingest(batch), AuthorityConflictError);
    assert.equal(authorityStore.allEvents().length, 1);
    assert.equal(authorityStore.allEvents()[0].id, "concurrent-event");
  });

  it("does not partially commit a failed pending create or its duplicates", async () => {
    const { authorityStore, service } = createHarness();
    authorityStore.commitConversationIntake = async () => { throw new AuthorityConflictError(); };
    const batch = createBatch();
    batch.records.push({ ...batch.records[0] });
    await assert.rejects(service.ingest(batch), AuthorityConflictError);
    assert.equal(authorityStore.allEvents().length, 0);
  });

  it("rejects unbound ingest dispositions before mutating events or existing decisions", async () => {
    const store = new MemoryAuthorityStore();
    const now = "2026-08-08T00:00:00.000Z";
    const existing = await store.append({
      id: "original", org_id: "org", source: "synthetic", external_id: "old",
      occurred_at: now, expected_head_id: null,
    });
    const initial = {
      event_id: existing.id, org_id: "org", disposition: "outside_current_work",
      layer: "L1_event", reason_codes: [], score: 1, decided_at: now,
    };
    await store.putDispositionIfAbsent(initial);
    const original = await store.getDisposition(existing.id);
    const append = {
      id: "new", org_id: "org", source: "synthetic", external_id: "new",
      occurred_at: now, expected_head_id: null,
    };
    const decision = { ...initial, event_id: "new", disposition: "current_work" };
    for (const request of [
      { appends: [append], dispositions: [{ ...decision, event_id: existing.id }] },
      { appends: [append], dispositions: [{ ...decision, org_id: "other-org" }] },
      { appends: [append], dispositions: [decision, decision] },
      { appends: [append, append], dispositions: [decision] },
    ]) {
      await assert.rejects(store.commitIngest(request), /Ingest (dispositions|event IDs)/);
      assert.deepEqual(await store.getDisposition(existing.id), original);
      assert.equal(await store.findBySourceIdentity(append), null);
    }
    await assert.rejects(store.commitIngest({
      appends: [append, { ...append, id: existing.id, external_id: "collision" }],
      dispositions: [decision, { ...decision, event_id: existing.id }],
    }), /Event ID already exists/);
    assert.equal(await store.findBySourceIdentity(append), null);
    assert.deepEqual(await store.getDisposition(existing.id), original);
    const input = {
      ...existing, id: "revision", parent_event_id: existing.id, expected_head_id: existing.id,
      disposition: { ...decision, event_id: existing.id },
    };
    await assert.rejects(store.appendRevision(input), /Event disposition must match/);
    await assert.rejects(store.markTombstone(input), /Event disposition must match/);
    assert.equal((await store.findBySourceIdentity(existing)).id, existing.id);
    assert.deepEqual(await store.getDisposition(existing.id), original);
  });

  it("allocates implicit memory event IDs without colliding with existing or later explicit IDs", async () => {
    const store = new MemoryAuthorityStore();
    const base = {
      org_id: "org", source: "synthetic", occurred_at: "2026-08-08T00:00:00.000Z",
      expected_head_id: null,
    };
    await store.append({ ...base, id: "event-1", external_id: "existing" });
    const events = await store.commitIngest({
      appends: [
        { ...base, external_id: "implicit" },
        { ...base, id: "event-2", external_id: "explicit" },
      ],
      dispositions: [],
    });
    assert.deepEqual(events.map((event) => event.id), ["event-3", "event-2"]);
  });

  it("unfolds current-head disposition changes and restores without overriding later human intent", async () => {
    const store = new MemoryAuthorityStore();
    const now = "2026-08-08T00:00:00.000Z";
    for (const mode of ["transition", "restore", "human", "stale"]) {
      const thread = `disposition-${mode}`;
      const event = await store.append({
        id: thread, org_id: "org", source: "synthetic", external_id: thread, thread_id: thread,
        occurred_at: now, expected_head_id: null,
      });
      if (mode === "stale") {
        await store.appendRevision({
          ...event, id: "replacement-disposition", parent_event_id: event.id, expected_head_id: event.id,
        });
      }
      const initial = {
        event_id: event.id, org_id: "org", disposition: "outside_current_work",
        layer: "L1_event", reason_codes: [], score: 1, decided_at: now,
      };
      if (mode !== "restore") await store.putDispositionIfAbsent(initial);
      if (mode === "human") {
        await store.setConversationVisibility({
          org_id: "org", thread_id: thread, hidden: true, expected_version: 0, updated_at: now,
        });
      } else {
        await store.setConversationPolicyHidden({
          org_id: "org", thread_id: thread, expected_visibility_version: 0, updated_at: now,
        });
      }
      const decision = { ...initial, disposition: "current_work" };
      if (mode === "restore") {
        assert.equal(await store.putDispositionIfAbsent(decision), true);
        assert.equal(await store.putDispositionIfAbsent(decision), false);
      } else {
        const command = {
          org_id: "org", event_id: event.id, action: "triage", disposition: "current_work",
          command_id: `command-${mode}`, issued_at: now,
        };
        const input = { expected: await store.getDisposition(event.id), decision, command };
        assert.equal((await store.transitionDisposition(input)).outcome, "applied");
        if (mode === "transition") {
          await store.setConversationVisibility({
            org_id: "org", thread_id: thread, hidden: true, expected_version: 0, updated_at: now,
          });
        }
        assert.equal((await store.transitionDisposition(input)).outcome, "replayed");
      }
      const pref = await store.getConversationPref("org", thread);
      assert.equal(pref.hidden, mode !== "restore");
      assert.equal(pref.hidden_reason, mode === "restore" ? null : mode === "stale" ? "policy" : "human");
    }
    assert.deepEqual(store.listCurrentWorkVisibilityEvents().map((event) => event.payload.cause),
      ["current_work_disposition_changed", "current_work_disposition_restored"]);
  });

  it("atomically unfolds policy-hidden current work while preserving human hides and stale heads", async () => {
    const store = new MemoryAuthorityStore();
    const now = "2026-08-08T00:00:00.000Z";
    for (const mode of ["policy", "human", "superseded"]) {
      const thread = `thread-${mode}`;
      const id = `event-${mode}`;
      if (mode === "human") {
        await store.setConversationVisibility({
          org_id: "org", thread_id: thread, hidden: true, expected_version: 0, updated_at: now,
        });
      } else {
        await store.setConversationPolicyHidden({
          org_id: "org", thread_id: thread, expected_visibility_version: 0, updated_at: now,
        });
      }
      const event = {
        id, org_id: "org", source: "synthetic", external_id: id, thread_id: thread,
        occurred_at: now, expected_head_id: null,
      };
      const decision = (eventId, disposition) => ({
        event_id: eventId, org_id: "org", disposition, layer: "L1_event",
        reason_codes: [], score: 1, decided_at: now,
      });
      await store.commitIngest({
        appends: mode === "superseded"
          ? [event, { ...event, id: "replacement", operation: "revise", parent_event_id: id, expected_head_id: id }]
          : [event],
        dispositions: mode === "superseded"
          ? [decision(id, "current_work"), decision("replacement", "outside_current_work")]
          : [decision(id, "current_work")],
      });
      const pref = await store.getConversationPref("org", thread);
      assert.equal(pref.hidden, mode !== "policy");
      assert.equal(pref.hidden_reason, mode === "policy" ? null : mode === "human" ? "human" : "policy");
      assert.equal(pref.visibility_version, mode === "human" ? 1 : 0);
    }
    assert.deepEqual(store.listCurrentWorkVisibilityEvents().map((event) => event.payload.event_id),
      ["event-policy"]);
  });

  it("claims memory outbound attempts atomically and isolates receipt mutations", async () => {
    const store = new MemoryAuthorityStore();
    const input = {
      org_id: "local-owner", client_request_id: "shared-reply", thread_id: "feishu:oc_1",
      recovery_hash: "a".repeat(64), now: "2026-08-24T00:00:00.000Z",
    };
    const claims = await Promise.all(Array.from({ length: 20 }, () => store.claimOutboundAttempt(input)));
    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal(await store.claimOutboundAttempt({ ...input, org_id: "other-owner" }), true);
    const receipt = { accepted: true, channel_message_ids: ["om_1"] };
    const accepted = await store.putOutboundAttempt({ ...input, status: "accepted", receipt });
    receipt.channel_message_ids.push("input-mutation");
    accepted.receipt.channel_message_ids.push("output-mutation");
    const read = await store.getOutboundAttempt(input.org_id, input.client_request_id);
    assert.deepEqual(read.receipt.channel_message_ids, ["om_1"]);
    read.receipt.channel_message_ids.push("read-mutation");
    const sent = await store.putOutboundAttempt({
      org_id: input.org_id, client_request_id: input.client_request_id,
      thread_id: input.thread_id, status: "sent", now: input.now,
    });
    assert.deepEqual(sent.receipt.channel_message_ids, ["om_1"]);
    assert.equal(sent.recovery_hash, input.recovery_hash);
  });

  it("reclaims only confirmed memory rejections for the same thread", async () => {
    const store = new MemoryAuthorityStore();
    const input = {
      org_id: "local-owner", client_request_id: "rejected-reply", thread_id: "feishu:oc_1",
      recovery_hash: "a".repeat(64), now: "2026-08-24T00:00:00.000Z",
    };
    await store.putOutboundAttempt({ ...input, status: "rejected" });
    assert.equal(await store.claimOutboundAttempt({ ...input, thread_id: "feishu:other" }), false);
    const claims = await Promise.all(Array.from({ length: 20 }, () => store.claimOutboundAttempt({
      ...input, recovery_hash: "b".repeat(64), now: "2026-08-25T00:00:00.000Z",
    })));
    assert.equal(claims.filter(Boolean).length, 1);
    const pending = await store.getOutboundAttempt(input.org_id, input.client_request_id);
    assert.equal(pending.status, "pending");
    assert.equal(pending.created_at, input.now);
    assert.equal(pending.recovery_hash, "b".repeat(64));
    for (const evidence of [{ receipt: { accepted: true } }, { channel_message_ids: [] }]) {
      await store.putOutboundAttempt({ ...input, status: "rejected", ...evidence });
      assert.equal(await store.claimOutboundAttempt(input), false);
    }
    await store.putOutboundAttempt({ ...input, status: "failed" });
    assert.equal(await store.claimOutboundAttempt(input), false);
  });

  it("preserves native thread and reply identities without using revision lineage", async () => {
    const { authorityStore, service } = createHarness();
    const result = await service.ingest(createBatch({
      thread: { id: "native-thread-1" },
      parent_external_id: "source-event-parent",
    }));

    assert.equal(result.valid, true);
    const [event] = authorityStore.allEvents();
    assert.equal(event.parent_event_id, undefined);
    assert.equal(event.attrs.native_thread_id, "native-thread-1");
    assert.equal(event.attrs.parent_external_id, "source-event-parent");
  });

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
    const batch = createBatch({
      direction_tags: ["follow_up", "outbound", "follow_up"],
      weight_hints: {
        urgency: 0.8, importance: 0.6, evidence_class: "metric", role_tier: 4,
      },
      attrs: { project: "regenic" },
    });

    const first = await service.ingest(batch);
    const replay = await service.ingest(batch);

    assert.equal(first.records[0].status, "accepted");
    assert.equal(replay.records[0].status, "duplicate");
    assert.equal(replay.records[0].event_id, first.records[0].event_id);
    assert.equal(authorityStore.allEvents().length, 1);
    assert.deepEqual(
      {
        thread_id: authorityStore.allEvents()[0].thread_id,
        actor_id: authorityStore.allEvents()[0].actor_id,
        required_scope_ids: authorityStore.allEvents()[0].required_scope_ids,
        direction_tags: authorityStore.allEvents()[0].direction_tags,
        weight_hints: authorityStore.allEvents()[0].weight_hints,
        attrs: authorityStore.allEvents()[0].attrs,
      },
      {
        thread_id: "regenic:source-event-1",
        actor_id: "local-owner",
        required_scope_ids: ["regenic:personal"],
        direction_tags: ["follow_up", "outbound"],
        weight_hints: {
          urgency: 0.8, importance: 0.6, evidence_class: "metric", role_tier: 4,
        },
        attrs: { project: "regenic" },
      },
    );
    assert.equal(blobStore.size, 1);
  });

  it("does not fall back to a non-atomic write after an intake conflict", async () => {
    const { authorityStore, service } = createHarness();
    authorityStore.commitConversationIntake = async () => {
      throw new AuthorityConflictError();
    };
    await assert.rejects(service.ingest(createBatch({ type: "task" })), AuthorityConflictError);
    assert.equal(authorityStore.allEvents().length, 0);
    assert.equal(authorityStore.listIngestionLifecycleEvents().length, 0);
  });

  it("keeps Feishu thread replies on the parent chat identity", async () => {
    const { authorityStore, service } = createHarness();
    const batch = createBatch({
      source: "feishu",
      external_id: "oc_1:om_reply",
      thread: { id: "oc_1:om_root" },
      scope: { id: "oc_1", name: "engineering" },
    });
    const result = await service.ingest(batch);
    assert.equal(result.records[0].status, "accepted");
    assert.equal(authorityStore.allEvents()[0].thread_id, "feishu:oc_1");
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

  it("atomically records memory ingestion disposition changes for revisions and tombstones", async () => {
    const { authorityStore, service } = createHarness();
    const created = await service.ingest(createBatch({ type: "task" }));
    const originalId = created.records[0].event_id;

    const revised = await service.ingest(createBatch({
      operation: "revise",
      revision_id: "revision-current-work",
      type: "text",
      content: [{ role: "body", media_type: "text/plain", text: "ok" }],
    }));
    const revisedId = revised.records[0].event_id;
    assert.equal((await authorityStore.getDisposition(revisedId)).disposition,
      "outside_current_work");
    const revisionAudit = authorityStore.listIngestionLifecycleEvents()
      .find((event) => event.aggregate_id === revisedId);
    assert.equal(revisionAudit.payload.previous.event_id, originalId);
    assert.equal(revisionAudit.payload.previous.disposition, "current_work");

    const tombstoned = await service.ingest(createBatch({
      operation: "tombstone",
      content: undefined,
    }));
    assert.equal((await authorityStore.getDisposition(tombstoned.records[0].event_id))
      .disposition, "outside_current_work");
    assert.equal(authorityStore.allEvents().at(-1).operation, "tombstone");
  });

  it("increments memory disposition versions only when disposition content changes", async () => {
    const { authorityStore, service } = createHarness();
    const created = await service.ingest(createBatch());
    const eventId = created.records[0].event_id;
    const initial = await authorityStore.getDisposition(eventId);
    assert.equal(initial.version, 0);

    assert.equal(await authorityStore.putDispositionIfAbsent(initial), false);
    assert.equal((await authorityStore.getDisposition(eventId)).version, 0);

    assert.equal(await authorityStore.putDispositionIfAbsent({
      ...initial,
      disposition: "pending",
      decided_at: "2026-08-26T00:01:00.000Z",
    }), false);
    const changed = await authorityStore.transitionDisposition({
      expected: initial,
      decision: {
        ...initial,
        disposition: "pending",
        decided_at: "2026-08-26T00:01:00.000Z",
      },
      command: {
        org_id: initial.org_id,
        event_id: initial.event_id,
        action: "triage",
        disposition: "pending",
        command_id: "ingestion-test-triage",
        issued_at: "2026-08-26T00:01:00.000Z",
      },
    });
    assert.equal(changed.outcome, "applied");
    assert.equal((await authorityStore.getDisposition(eventId)).version, 1);
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
    assert.equal(events[1].thread_id, events[0].thread_id);
    assert.deepEqual(events[1].required_scope_ids, events[0].required_scope_ids);
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
    const events = authorityStore.allEvents();
    assert.equal(events.length, 2);
    assert.equal(events[1].thread_id, events[0].thread_id);
    assert.deepEqual(events[1].required_scope_ids, events[0].required_scope_ids);
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
    assert.equal((await authorityStore.getDisposition(events.at(-1).id)).disposition,
      "outside_current_work");
    assert.equal(authorityStore.listIngestionLifecycleEvents()
      .some((event) => event.aggregate_id === events.at(-1).id), false);
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

  it("creates the matching work item in the atomic intake", async () => {
    const { authorityStore, service } = createHarness();
    const result = await service.ingest(createBatch({ type: "task" }));
    const eventId = result.records[0].event_id;

    assert.equal(result.records[0].status, "accepted");
    assert.equal((await authorityStore.getDisposition(eventId)).disposition, "current_work");
    assert.equal(
      (await authorityStore.getWorkItemByThread("local-owner", "regenic:source-event-1"))
        .head_event_id,
      eventId,
    );
  });

  it("rolls back event and disposition writes when a work observation conflicts", async () => {
    const authorityStore = new MemoryAuthorityStore();
    const now = "2026-08-08T00:00:00.000Z";
    const eventId = "atomic-intake-event";
    await assert.rejects(authorityStore.commitConversationIntake({
      ingest: {
        appends: [{
          id: eventId,
          org_id: "org",
          source: "synthetic",
          external_id: "atomic-intake",
          thread_id: "thread",
          content_hash: "a".repeat(64),
          occurred_at: now,
          expected_head_id: null,
        }],
        dispositions: [{
          event_id: eventId,
          org_id: "org",
          disposition: "current_work",
          layer: "L1_event",
          reason_codes: [],
          score: 1,
          decided_at: now,
        }],
      },
      work_observations: [{
        expected_item: null,
        item: {
          id: "work-item",
          org_id: "org",
          thread_id: "wrong-thread",
          unit_key: eventId,
          head_event_id: eventId,
          record_class: "task",
          thread_facet: "task",
          status: "open",
          created_at: now,
          updated_at: now,
        },
      }],
      visibility: [],
    }), AuthorityConflictError);

    assert.equal(await authorityStore.findBySourceIdentity({
      org_id: "org",
      source: "synthetic",
      external_id: "atomic-intake",
    }), null);
    assert.equal(await authorityStore.getDisposition(eventId), null);
    assert.equal(await authorityStore.getWorkItemByThread("org", "wrong-thread"), null);
  });

  it("rolls back replay disposition repairs and visibility when a work observation conflicts", async () => {
    const authorityStore = new MemoryAuthorityStore();
    const now = "2026-08-08T00:00:00.000Z";
    const eventId = "atomic-replay-repair";
    const identity = {
      org_id: "org",
      source: "synthetic",
      external_id: "atomic-replay-repair",
    };
    const event = await authorityStore.append({
      id: eventId,
      ...identity,
      thread_id: "thread",
      content_hash: "a".repeat(64),
      occurred_at: now,
      expected_head_id: null,
    });
    await authorityStore.setConversationPolicyVisibility({
      org_id: "org",
      thread_id: "thread",
      hidden: true,
      expected_visibility_version: 0,
      updated_at: now,
    });

    await assert.rejects(authorityStore.commitConversationIntake({
      ingest: { appends: [], dispositions: [] },
      disposition_repairs: [{
        identities: [identity],
        decision: {
          event_id: event.id,
          org_id: "org",
          disposition: "current_work",
          layer: "L1_event",
          reason_codes: [],
          score: 1,
          decided_at: now,
        },
      }],
      work_observations: [{
        expected_item: null,
        item: {
          id: "work-item",
          org_id: "org",
          thread_id: "wrong-thread",
          unit_key: event.id,
          head_event_id: event.id,
          record_class: "task",
          thread_facet: "task",
          status: "open",
          created_at: now,
          updated_at: now,
        },
      }],
      visibility: [],
    }), AuthorityConflictError);

    assert.equal(await authorityStore.getDisposition(event.id), null);
    assert.equal(
      (await authorityStore.getConversationPref("org", "thread")).hidden,
      true,
    );
    assert.deepEqual(await authorityStore.listInbox("org"), []);
  });

  it("does not commit replay disposition repairs after an atomic sync-page conflict", async () => {
    const { authorityStore, blobStore, service } = createHarness();
    const batch = createBatch();
    const record = batch.records[0];
    const canonical = canonicalizeRecordContent(record);
    await blobStore.put(canonical.hash, canonical.bytes, canonical.media_type);
    const event = await authorityStore.append({
      id: "sync-replay-repair",
      org_id: batch.org_id,
      source: record.source,
      external_id: record.external_id,
      thread_id: "regenic:source-event-1",
      content_hash: canonical.hash,
      content_media_type: canonical.media_type,
      content_byte_size: canonical.bytes.byteLength,
      occurred_at: record.occurred_at,
      expected_head_id: null,
    });
    await authorityStore.setConversationPolicyVisibility({
      org_id: batch.org_id,
      thread_id: "regenic:source-event-1",
      hidden: true,
      expected_visibility_version: 0,
      updated_at: "2026-08-08T00:00:00.000Z",
    });
    authorityStore.atomicSyncPage = true;
    authorityStore.commitSyncPage = async () => {
      throw new AuthorityConflictError();
    };
    let standaloneWrites = 0;
    const commitIntake = authorityStore.commitConversationIntake.bind(authorityStore);
    authorityStore.commitConversationIntake = async (request) => {
      standaloneWrites += 1;
      return commitIntake(request);
    };

    const result = await service.ingest(batch, {
      attempt: {
        id: "attempt-replay-repair",
        org_id: batch.org_id,
        connector_installation_id: "install-1",
        stream_key: "personal",
        delivery_id: batch.delivery_id,
        started_at: "2026-08-08T00:00:00.000Z",
      },
      settle: {
        attempt_id: "attempt-replay-repair",
        installation_id: "install-1",
        stream_key: "personal",
        lease_owner: "worker-a",
        finished_at: "2026-08-08T00:00:01.000Z",
      },
    }, authorityStore);

    assert.equal(result.records[0].status, "retryable_failure");
    assert.equal(await authorityStore.getDisposition(event.id), null);
    assert.equal(
      (await authorityStore.getConversationPref(
        batch.org_id,
        "regenic:source-event-1",
      )).hidden,
      true,
    );
    assert.equal(standaloneWrites, 0);
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

  it("binds channel-native ids as aliases of a local outbound", async () => {
    const { authorityStore, service } = createHarness();
    const outbound = await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "feishu-chat",
      org_id: "local-owner",
      delivery_id: "out-alias-1",
      received_at: "2026-08-21T00:00:00.000Z",
      records: [
        channelRecord({
          channel: "feishu",
          kind: "user",
          direction: "outbound",
          external_id: "oc_1:out:om_text",
          occurred_at: "2026-08-21T00:00:00.000Z",
          actor_id: "local-owner",
          scope_id: "oc_1",
          text: "hello",
        }),
      ],
    });
    const eventId = outbound.records[0].event_id;
    await authorityStore.bindSourceIdentityAliases({
      org_id: "local-owner",
      event_id: eventId,
      aliases: [
        { source: "feishu", external_id: "oc_1:om_text" },
        { source: "feishu", external_id: "oc_1:om_image" },
      ],
    });
    const echoed = await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "feishu-chat",
      org_id: "local-owner",
      delivery_id: "sync-alias-1",
      received_at: "2026-08-21T00:00:02.000Z",
      records: [
        channelRecord({
          channel: "feishu",
          kind: "user",
          direction: "outbound",
          external_id: "oc_1:om_text",
          occurred_at: "2026-08-21T00:00:01.000Z",
          actor_id: "ou_me",
          scope_id: "oc_1",
          text: "hello",
        }),
        channelRecord({
          channel: "feishu",
          kind: "user",
          direction: "outbound",
          external_id: "oc_1:om_image",
          occurred_at: "2026-08-21T00:00:01.100Z",
          actor_id: "ou_me",
          scope_id: "oc_1",
          direction_tags: ["outbound"],
          content: [
            {
              role: "attachment",
              media_type: "image/png",
              source_filename: "shot.png",
              bytes: Buffer.from("png-bytes"),
            },
          ],
        }),
      ],
    });
    assert.equal(echoed.records[0].status, "duplicate");
    assert.equal(echoed.records[1].status, "duplicate");
    assert.equal(echoed.records[0].event_id, eventId);
    assert.equal(echoed.records[1].event_id, eventId);
  });

  it("does not echo-match same text with different attachment digests", async () => {
    const { service } = createHarness();
    const firstPng = Buffer.from("image-one");
    const secondPng = Buffer.from("image-two");
    await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "feishu-chat",
      org_id: "local-owner",
      delivery_id: "out-diff-1",
      received_at: "2026-08-21T00:00:00.000Z",
      records: [
        channelRecord({
          channel: "feishu",
          kind: "user",
          direction: "outbound",
          external_id: "oc_1:out:om_a",
          occurred_at: "2026-08-21T00:00:00.000Z",
          actor_id: "local-owner",
          scope_id: "oc_1",
          text: "same caption",
          content: [
            {
              role: "attachment",
              media_type: "image/png",
              source_filename: "a.png",
              bytes: firstPng,
            },
          ],
        }),
      ],
    });
    const second = await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "feishu-chat",
      org_id: "local-owner",
      delivery_id: "sync-diff-1",
      received_at: "2026-08-21T00:00:02.000Z",
      records: [
        channelRecord({
          channel: "feishu",
          kind: "user",
          direction: "outbound",
          external_id: "oc_1:om_b",
          occurred_at: "2026-08-21T00:00:01.000Z",
          actor_id: "ou_me",
          scope_id: "oc_1",
          text: "same caption",
          content: [
            {
              role: "attachment",
              media_type: "image/png",
              source_filename: "b.png",
              bytes: secondPng,
            },
          ],
        }),
      ],
    });
    assert.equal(second.records[0].status, "accepted");
  });

  it("rejects sync-page ingestion without the same atomic runtime store", async () => {
    const { authorityStore, service } = createHarness();
    let intakeWrites = 0;
    let pageWrites = 0;
    const originalIntake = authorityStore.commitConversationIntake.bind(authorityStore);
    authorityStore.commitConversationIntake = async (request) => {
      intakeWrites += 1;
      return originalIntake(request);
    };
    const originalPage = authorityStore.commitSyncPage.bind(authorityStore);
    authorityStore.commitSyncPage = async (request) => {
      pageWrites += 1;
      return originalPage(request);
    };
    await assert.rejects(service.ingest(createBatch(), {
      attempt: {
        id: "attempt-page",
        org_id: "local-owner",
        connector_installation_id: "install-1",
        stream_key: "personal",
        delivery_id: "delivery-1",
        started_at: "2026-08-08T00:00:00.000Z",
      },
      settle: {
        attempt_id: "attempt-page",
        installation_id: "install-1",
        stream_key: "personal",
        lease_owner: "worker-a",
        finished_at: "2026-08-08T00:00:01.000Z",
      },
    }), /same atomic Authority and runtime store/);
    assert.equal(pageWrites, 0);
    assert.equal(intakeWrites, 0);
    assert.equal(authorityStore.allEvents().length, 0);
  });

  it("unfolds a policy-hidden thread through standalone Authority ingestion", async () => {
    const { authorityStore, service } = createHarness();
    await authorityStore.setConversationPolicyVisibility({
      org_id: "local-owner",
      thread_id: "regenic:source-event-1",
      hidden: true,
      expected_visibility_version: 0,
      updated_at: "2026-08-08T00:00:00.000Z",
    });
    let pagePolicyWrites = 0;
    const originalPage = authorityStore.commitSyncPage.bind(authorityStore);
    authorityStore.commitSyncPage = async (request) => {
      pagePolicyWrites += request.prefs.length;
      return originalPage(request);
    };
    await service.ingest(createBatch());
    const pref = await authorityStore.getConversationPref(
      "local-owner",
      "regenic:source-event-1",
    );
    assert.equal(pagePolicyWrites, 0);
    assert.equal(pref.hidden, false);
  });

  it("rejects a revised sync page without the same atomic runtime store", async () => {
    const { authorityStore, service } = createHarness();
    await service.ingest(createBatch());
    const revised = createBatch({
      operation: "revise",
      content: [
        {
          role: "body",
          media_type: "text/plain",
          text: "Revised canonical body.",
        },
      ],
    });
    await assert.rejects(service.ingest(revised, {
      attempt: {
        id: "attempt-revise",
        org_id: "local-owner",
        connector_installation_id: "install-1",
        stream_key: "personal",
        delivery_id: "delivery-2",
        started_at: "2026-08-08T00:00:02.000Z",
      },
      settle: {
        attempt_id: "attempt-revise",
        installation_id: "install-1",
        stream_key: "personal",
        lease_owner: "worker-a",
        finished_at: "2026-08-08T00:00:03.000Z",
      },
    }), /same atomic Authority and runtime store/);
    assert.equal(authorityStore.allEvents().length, 1);
    assert.equal(
      (await authorityStore.findBySourceIdentity({
        org_id: "local-owner",
        source: revised.records[0].source,
        external_id: revised.records[0].external_id,
      })).operation,
      "create",
    );
  });
});