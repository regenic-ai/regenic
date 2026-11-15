const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  arrangeMessage,
  canonicalizeRecordContent,
  IngestionService,
  MemoryAuthorityStore,
  MemoryBlobStore,
  INGEST_SCHEMA_VERSION,
  conversationId,
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

async function setDisposition(store, decision) {
  const expected = await store.getDisposition(decision.event_id);
  const result = await store.transitionDisposition({
    expected,
    decision,
    command: {
      org_id: decision.org_id,
      event_id: decision.event_id,
      action: "triage",
      disposition: decision.disposition,
      command_id: `arrangement-test-${decision.event_id}`,
      issued_at: decision.decided_at,
    },
  });
  assert.equal(result.outcome, "applied");
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

  it("keeps a task record in current work", () => {
    const decision = arrangeMessage({
      event: event({ source: "feishu" }),
      type: "task",
      text: "Approve travel",
    });
    assert.equal(decision.disposition, "current_work");
    assert.deepEqual(decision.reason_codes, ["task"]);
  });

  it("keeps a thread status marker out of current work", () => {
    const decision = arrangeMessage({
      event: event({ source: "dsh" }),
      type: "thread_status",
      kind: "system",
      text: "",
    });
    assert.equal(decision.disposition, "outside_current_work");
    assert.deepEqual(decision.reason_codes, ["thread_status"]);
  });

  it("keeps a short assistant reply out of current work", () => {
    const decision = arrangeMessage({
      event: event({ source: "dsh" }),
      kind: "assistant",
      text: "pong",
    });
    assert.equal(decision.disposition, "outside_current_work");
    assert.deepEqual(decision.reason_codes, ["assistant_not_current_work"]);
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

  it("applies a personal policy to configurable dispositions only", () => {
    const policy = {
      version: 1,
      high_hint_disposition: "pending",
      actionable_disposition: "pending",
      short_text_disposition: "outside_current_work",
      default_disposition: "outside_current_work",
    };
    const actionable = arrangeMessage({
      event: event(),
      text: "Please review the release.",
      dispatch_policy: policy,
    });
    assert.equal(actionable.disposition, "pending");
    assert.deepEqual(actionable.reason_codes, ["policy_actionable"]);
    const defaulted = arrangeMessage({
      event: event(),
      text: "A detailed status update with no direct request.",
      dispatch_policy: policy,
    });
    assert.equal(defaulted.disposition, "outside_current_work");
    assert.deepEqual(defaulted.reason_codes, ["policy_default_personal_attention"]);
  });

  it("does not let a personal policy override safety filters", () => {
    const policy = {
      version: 1,
      high_hint_disposition: "current_work",
      actionable_disposition: "current_work",
      short_text_disposition: "current_work",
      default_disposition: "current_work",
    };
    assert.equal(
      arrangeMessage({ event: event(), text: "thanks", dispatch_policy: policy }).disposition,
      "outside_current_work",
    );
    assert.equal(
      arrangeMessage({ event: event(), kind: "assistant", text: "pong", dispatch_policy: policy }).disposition,
      "outside_current_work",
    );
    assert.equal(
      arrangeMessage({ event: event(), type: "task", text: "Approve travel", dispatch_policy: policy }).disposition,
      "current_work",
    );
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
  it("replays and audits an inbox disposition command only for matching command input", async () => {
    const authorityStore = new MemoryAuthorityStore();
    const service = new IngestionService(new MemoryBlobStore(), authorityStore);
    const accepted = await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "native-local",
      org_id: "local-owner",
      delivery_id: "disposition-command",
      received_at: "2026-08-21T00:00:00.000Z",
      records: [{
        operation: "create",
        source: "regenic",
        external_id: "disposition-event",
        occurred_at: "2026-08-21T00:00:00.000Z",
        actor: { id: "local-owner" },
        scope: { id: "personal" },
        type: "message",
        content: [{ role: "body", media_type: "text/plain", text: "Please confirm the release." }],
      }],
    });
    const eventId = accepted.records[0].event_id;
    const expected = await authorityStore.getDisposition(eventId);
    const decision = {
      ...expected,
      version: (expected.version ?? 0) + 1,
      disposition: "pending",
      reason_codes: [...expected.reason_codes, "human_triage"],
      decided_at: "2026-08-21T00:01:00.000Z",
    };
    const input = {
      expected,
      decision,
      command: {
        org_id: "local-owner",
        event_id: eventId,
        action: "triage",
        disposition: "pending",
        command_id: "memory-disposition-1",
        issued_at: "2026-08-21T00:01:00.000Z",
      },
    };
    assert.equal((await authorityStore.transitionDisposition(input)).outcome, "applied");
    const replay = await authorityStore.transitionDisposition(input);
    assert.equal(replay.outcome, "replayed");
    assert.deepEqual(replay.decision, decision);
    assert.equal((await authorityStore.transitionDisposition({
      ...input,
      command: { ...input.command, disposition: "outside_current_work" },
    })).outcome, "command_conflict");
    const audit = authorityStore.listInboxDispositionTransitions();
    assert.equal(audit.length, 1);
    assert.deepEqual(audit[0].previous, expected);
    assert.deepEqual(audit[0].decision, decision);
  });

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

  it("applies a saved dispatch policy to a new ingest batch", async () => {
    const authorityStore = new MemoryAuthorityStore();
    await authorityStore.putUiPref(
      "local-owner",
      "personal_dispatch_policy_v1",
      JSON.stringify({
        version: 1,
        high_hint_disposition: "pending",
        actionable_disposition: "pending",
        short_text_disposition: "outside_current_work",
        default_disposition: "outside_current_work",
      }),
      "2026-08-21T00:00:00.000Z",
    );
    const service = new IngestionService(new MemoryBlobStore(), authorityStore);

    const accepted = await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "native-local",
      org_id: "local-owner",
      delivery_id: "delivery-policy",
      received_at: "2026-08-21T00:00:00.000Z",
      records: [
        {
          operation: "create",
          source: "regenic",
          external_id: "ask-policy",
          occurred_at: "2026-08-21T00:00:00.000Z",
          actor: { id: "local-owner" },
          scope: { id: "personal" },
          type: "message",
          content: [{ role: "body", media_type: "text/plain", text: "Please confirm the release." }],
        },
        {
          operation: "create",
          source: "regenic",
          external_id: "noise-policy",
          occurred_at: "2026-08-21T00:01:00.000Z",
          actor: { id: "local-owner" },
          scope: { id: "personal" },
          type: "message",
          content: [{ role: "body", media_type: "text/plain", text: "ok" }],
        },
      ],
    });

    assert.equal(accepted.valid, true);
    assert.equal(
      (await authorityStore.getDisposition(accepted.records[0].event_id)).disposition,
      "pending",
    );
    assert.deepEqual(
      (await authorityStore.getDisposition(accepted.records[0].event_id)).reason_codes,
      ["policy_actionable"],
    );
    assert.equal(
      (await authorityStore.getDisposition(accepted.records[1].event_id)).disposition,
      "outside_current_work",
    );
    assert.deepEqual(
      (await authorityStore.getDisposition(accepted.records[1].event_id)).reason_codes,
      ["noise"],
    );
  });

  it("keeps the default policy when the saved dispatch policy is invalid", async () => {
    const authorityStore = new MemoryAuthorityStore();
    await authorityStore.putUiPref(
      "local-owner",
      "personal_dispatch_policy_v1",
      "{",
      "2026-08-21T00:00:00.000Z",
    );
    const service = new IngestionService(new MemoryBlobStore(), authorityStore);
    const accepted = await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "native-local",
      org_id: "local-owner",
      delivery_id: "delivery-invalid-policy",
      received_at: "2026-08-21T00:00:00.000Z",
      records: [{
        operation: "create",
        source: "regenic",
        external_id: "ask-default",
        occurred_at: "2026-08-21T00:00:00.000Z",
        actor: { id: "local-owner" },
        scope: { id: "personal" },
        type: "message",
        content: [{ role: "body", media_type: "text/plain", text: "Please confirm the release." }],
      }],
    });

    assert.deepEqual(
      (await authorityStore.getDisposition(accepted.records[0].event_id)).reason_codes,
      ["actionable"],
    );
  });

  it("does not replace a human triage when a duplicate is replayed", async () => {
    const authorityStore = new MemoryAuthorityStore();
    const service = new IngestionService(new MemoryBlobStore(), authorityStore);
    const record = {
      operation: "create",
      source: "regenic",
      external_id: "ask-triage",
      occurred_at: "2026-08-21T00:00:00.000Z",
      actor: { id: "local-owner" },
      scope: { id: "personal" },
      type: "message",
      content: [{ role: "body", media_type: "text/plain", text: "Please confirm the release." }],
    };
    const accepted = await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "native-local",
      org_id: "local-owner",
      delivery_id: "delivery-triage",
      received_at: "2026-08-21T00:00:00.000Z",
      records: [record],
    });
    const current = await authorityStore.getDisposition(accepted.records[0].event_id);
    await setDisposition(authorityStore, {
      ...current,
      disposition: "outside_current_work",
      reason_codes: [...current.reason_codes, "human_triage"],
    });
    await authorityStore.putUiPref(
      "local-owner",
      "personal_dispatch_policy_v1",
      JSON.stringify({
        version: 1,
        high_hint_disposition: "pending",
        actionable_disposition: "pending",
        short_text_disposition: "pending",
        default_disposition: "pending",
      }),
      "2026-08-21T00:01:00.000Z",
    );

    const replayed = await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "native-local",
      org_id: "local-owner",
      delivery_id: "delivery-triage-replay",
      received_at: "2026-08-21T00:02:00.000Z",
      records: [record],
    });

    assert.equal(replayed.records[0].status, "duplicate");
    const decision = await authorityStore.getDisposition(accepted.records[0].event_id);
    assert.equal(decision.disposition, "outside_current_work");
    assert.ok(decision.reason_codes.includes("human_triage"));
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
    assert.equal(
      await authorityStore.putDispositionIfAbsent({
        event_id: event.id,
        org_id: "local-owner",
        disposition: "pending",
        layer: "L1_event",
        reason_codes: ["late-repair"],
        score: 0,
        decided_at: "2026-08-21T00:01:00.000Z",
      }),
      false,
    );
    const untriagedEvent = await authorityStore.append({
      org_id: "local-owner",
      source: record.source,
      external_id: "ask-cross-org-disposition",
      content_hash: canonical.hash,
      content_media_type: canonical.media_type,
      content_byte_size: canonical.bytes.byteLength,
      occurred_at: record.occurred_at,
      expected_head_id: null,
    });
    await assert.rejects(
      authorityStore.putDispositionIfAbsent({
        event_id: untriagedEvent.id,
        org_id: "another-org",
        disposition: "pending",
        layer: "L1_event",
        reason_codes: ["cross-org"],
        score: 0,
        decided_at: "2026-08-21T00:01:00.000Z",
      }),
      /not owned by the requested organization/,
    );
  });

  it("does not overwrite a triage committed after a missing-disposition read", async () => {
    const authorityStore = new MemoryAuthorityStore();
    const blobStore = new MemoryBlobStore();
    const service = new IngestionService(blobStore, authorityStore);
    const record = {
      operation: "create",
      source: "regenic",
      external_id: "ask-stale-disposition",
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
    const getDisposition = authorityStore.getDisposition.bind(authorityStore);
    let injectedTriage = false;
    authorityStore.getDisposition = async (eventId) => {
      const current = await getDisposition(eventId);
      if (eventId === event.id && !current && !injectedTriage) {
        injectedTriage = true;
        await authorityStore.putDispositionIfAbsent({
          event_id: event.id,
          org_id: "local-owner",
          disposition: "pending",
          layer: "L1_event",
          reason_codes: ["human_triage"],
          score: 1,
          decided_at: "2026-08-21T00:01:00.000Z",
        });
        return null;
      }
      return current;
    };

    const replayed = await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "native-local",
      org_id: "local-owner",
      delivery_id: "delivery-stale-disposition",
      received_at: "2026-08-21T00:02:00.000Z",
      records: [record],
    });

    assert.equal(replayed.records[0].status, "duplicate");
    const decision = await getDisposition(event.id);
    assert.equal(decision.disposition, "pending");
    assert.deepEqual(decision.reason_codes, ["human_triage"]);
  });

  it("fences work-acknowledged disposition changes against concurrent triage", async () => {
    const authorityStore = new MemoryAuthorityStore();
    const service = new IngestionService(new MemoryBlobStore(), authorityStore);
    const accepted = await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "native-local",
      org_id: "local-owner",
      delivery_id: "delivery-work-ack",
      received_at: "2026-08-21T00:00:00.000Z",
      records: [{
        operation: "create",
        source: "regenic",
        external_id: "ask-work-ack",
        occurred_at: "2026-08-21T00:00:00.000Z",
        actor: { id: "local-owner" },
        scope: { id: "personal" },
        type: "message",
        content: [{ role: "body", media_type: "text/plain", text: "Please confirm the release." }],
      }],
    });
    const eventId = accepted.records[0].event_id;
    const initial = await authorityStore.getDisposition(eventId);
    const triaged = {
      ...initial,
      version: (initial.version ?? 0) + 1,
      disposition: "pending",
      reason_codes: [...initial.reason_codes, "human_triage"],
    };
    await authorityStore.transitionDisposition({
      expected: initial,
      decision: triaged,
      command: {
        org_id: "local-owner",
        event_id: eventId,
        action: "triage",
        disposition: "pending",
        command_id: "triage-before-work-ack",
        issued_at: "2026-08-21T00:01:00.000Z",
      },
    });
    const staleAck = await authorityStore.transitionDisposition({
      expected: initial,
      decision: {
        ...initial,
        disposition: "outside_current_work",
        reason_codes: [...initial.reason_codes, "work_acked"],
      },
      command: {
        org_id: "local-owner",
        event_id: eventId,
        action: "work_acked",
        command_id: "work-acked-command",
        issued_at: "2026-08-21T00:02:00.000Z",
      },
    });
    assert.deepEqual(staleAck, { outcome: "conflict" });
    assert.deepEqual(await authorityStore.getDisposition(eventId), triaged);
  });

  it("restores the current trigger when manually retrying an acknowledged failure", async () => {
    const authorityStore = new MemoryAuthorityStore();
    const now = "2026-08-25T00:00:00.000Z";
    const recipe = {
      id: "manual-retry-recipe",
      org_id: "local-owner",
      name: "Manual retry",
      match: { record_class: "task" },
      trigger: { kind: "push", coalesce: true },
      executor_type: "exec",
      executor_config: {},
      can_write_back: false,
      include_context: false,
      enabled: true,
      created_at: now,
      updated_at: now,
    };
    await authorityStore.putRecipe(recipe);
    const service = new IngestionService(new MemoryBlobStore(), authorityStore);
    const accepted = await service.ingest({
      schema_version: INGEST_SCHEMA_VERSION,
      connector_id: "native-local",
      org_id: "local-owner",
      delivery_id: "manual-retry-ingest",
      received_at: now,
      records: [{
        operation: "create",
        source: "regenic",
        external_id: "manual-retry-trigger",
        occurred_at: now,
        actor: { id: "local-owner" },
        scope: { id: "personal" },
        type: "message",
        content: [{ role: "body", media_type: "text/plain", text: "Please review this." }],
      }],
    });
    const eventId = accepted.records[0].event_id;
    assert.equal((await authorityStore.getDisposition(eventId)).disposition, "current_work");
    const threadId = conversationId("regenic", "manual-retry-trigger", eventId);
    const item = {
      id: "manual-retry-work",
      org_id: "local-owner",
      recipe_id: recipe.id,
      thread_id: threadId,
      unit_key: eventId,
      head_event_id: eventId,
      record_class: "task",
      thread_facet: "ticket",
      status: "open",
      created_at: now,
      updated_at: now,
    };
    const created = await authorityStore.createWorkItem({
      item,
      recipe,
      expected_recipe: recipe,
    });
    assert.equal(created.outcome, "applied");
    const run = {
      id: "manual-retry-failed-run",
      org_id: item.org_id,
      work_item_id: item.id,
      recipe_id: recipe.id,
      executor_type: "exec",
      status: "running",
      start_state: "pending",
      write_back_required: false,
      trigger_kind: "push",
      created_at: now,
      updated_at: now,
    };
    assert.equal(await authorityStore.claimWorkRunStart({ run, expected_recipe: recipe }), true);
    const started = await authorityStore.checkpointWorkRunStart({
      expected_item: await authorityStore.getWorkItem(item.org_id, item.id),
      expected_run: await authorityStore.getWorkRun(item.org_id, run.id),
      kind: "submitted",
      external_run_id: "manual-retry-executor-run",
      now,
    });
    assert.equal(started.outcome, "applied");
    const failed = await authorityStore.commitWorkObservation({
      expected_item: started.item,
      expected_run: started.run,
      handle: {
        external_run_id: "manual-retry-executor-run",
        status: "failed",
        result: { summary: "Reviewed failure" },
      },
      can_write_back: false,
      trigger_kind: "push",
      now: "2026-08-25T00:01:00.000Z",
    });
    assert.equal(failed.outcome, "applied");
    const acknowledged = await authorityStore.acknowledgeWorkResult({
      expected_item: failed.transition.item,
      run_id: run.id,
      trigger_event_id: eventId,
      expected_version: failed.transition.item.version,
      expected_run_version: failed.transition.run.version,
      command_id: "manual-retry-acknowledge",
      issued_at: "2026-08-25T00:02:00.000Z",
      now: "2026-08-25T00:02:00.000Z",
    });
    assert.equal(acknowledged.outcome, "applied");
    assert.equal((await authorityStore.getDisposition(eventId)).disposition, "outside_current_work");

    const retryRun = {
      ...run,
      id: "manual-retry-next-run",
      created_at: "2026-08-25T00:03:00.000Z",
      updated_at: "2026-08-25T00:03:00.000Z",
    };
    assert.equal(await authorityStore.claimWorkRunStart({
      run: retryRun,
      expected_recipe: recipe,
      expected_item: acknowledged.item,
      expected_version: acknowledged.item.version,
      retry: "manual",
    }), true);
    assert.equal((await authorityStore.getDisposition(eventId)).disposition, "current_work");
    assert.ok(authorityStore.listAcknowledgmentLifecycleEvents().some((event) =>
      event.event_type === "current_work_changed" && event.payload.source === "manual_retry"
      && event.aggregate_id === eventId));
  });
});
