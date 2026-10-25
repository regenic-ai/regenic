const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { describe, it } = require("node:test");
const { SqliteAuthorityStore } = require("@regenic/authority-store/sqlite");
const { FsBlobStore } = require("@regenic/blob-store");
const { ChannelDriverError, IngestionService, SendNotAcceptedError } = require("@regenic/domain");
const { PersonalReplyService } = require("../dist/personal-reply.service");
const { loadReplyRecovery } = require("../dist/personal-reply-recovery");

const ORG = "local-owner";
const THREAD = "feishu:oc_1";
const REQUEST = { thread_id: THREAD, text: "original reply", client_request_id: "reply-1" };
const RECEIPT = { accepted: true, rpc_id: "om_1", channel_message_ids: ["om_1", "om_2"] };
const errorCode = (code) => (error) => error.code === code;

async function harness(t) {
  const root = await mkdtemp(join(tmpdir(), "regenic-reply-recovery-"));
  const path = join(root, "authority.db");
  const ports = {
    authority: new SqliteAuthorityStore(path),
    blobs: new FsBlobStore(join(root, "blobs")),
    connectors: { listStreams: () => [] },
  };
  t.after(async () => {
    ports.authority.close();
    await rm(root, { recursive: true, force: true });
  });
  t.mock.method(console, "error", () => {});
  const sent = [];
  const ingested = [];
  const faults = {};
  ports.ingest = {
    async ingest(batch) {
      if (faults.ingest) throw new Error("local ingest unavailable");
      ingested.push(batch);
      return new IngestionService(ports.blobs, ports.authority).ingest(batch);
    },
  };
  const host = { get: (name) => ports[name] };
  const runtime = {
    orgId: () => ORG,
    requireHost: () => host,
    getOptions: () => ({ blobRoot: join(root, "blobs") }),
  };
  const inbox = {
    listInbox: async () => [],
    async getInboxItem(eventId) {
      const item = (await ports.authority.listInbox(ORG)).find((item) => item.event.id === eventId);
      return item ? { ...item, channel: item.event.source } : null;
    },
  };
  const driver = {
    source: "feishu",
    capabilities: () => ({ reply: true }),
    outboundId: (thread, receipt) => `${thread.target}:out:${receipt.rpc_id}`,
    async bindEgress() {
      if (faults.bind) throw new Error("sender unavailable");
      return {
        async send(intent) {
          sent.push(intent);
          if (faults.send) return faults.send(intent);
          return RECEIPT;
        },
      };
    },
  };
  const service = () => new PersonalReplyService(
    runtime, inbox, { followThread: async () => {} },
    { findForThread: () => ({ installation: { id: "feishu-1" }, driver }) },
  );
  return {
    ports, sent, ingested, faults, service,
    reopen() {
      ports.authority.close();
      ports.authority = new SqliteAuthorityStore(path);
      return service();
    },
  };
}

describe("durable personal reply delivery", () => {
  it("persists confirmed rejection and safely retries the same key after restart", async (t) => {
    const h = await harness(t);
    h.faults.send = async () => { throw new SendNotAcceptedError("throttled", "queue is full"); };
    await assert.rejects(h.service().send(REQUEST),
      (error) => error.code === "throttled" && error.httpStatus === 429);
    const rejected = await h.ports.authority.getOutboundAttempt(ORG, REQUEST.client_request_id);
    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.receipt, undefined);
    assert.equal(h.ingested.length, 0);
    await assert.rejects(h.service().send({ ...REQUEST, thread_id: "feishu:other" }), errorCode("invalid_reply"));
    h.faults.send = undefined;
    const restarted = h.reopen();
    const results = await Promise.allSettled([restarted.send(REQUEST), h.service().send(REQUEST)]);
    assert.ok(results.some((result) => result.status === "fulfilled" && result.value.accepted));
    for (const result of results.filter((result) => result.status === "rejected")) {
      assert.equal(result.reason.code, "send_uncertain");
    }
    assert.equal(h.sent.length, 2);
    const saved = await h.ports.authority.getOutboundAttempt(ORG, REQUEST.client_request_id);
    assert.equal(saved.status, "sent");
    assert.equal(saved.created_at, rejected.created_at);
    assert.equal((await restarted.send(REQUEST)).accepted, true);
    assert.equal(h.sent.length, 2);
  });

  it("does not infer safe retry from a throttling error after a possible partial send", async (t) => {
    const h = await harness(t);
    h.faults.send = async () => {
      throw new ChannelDriverError("throttled", "second message failed after the first was accepted");
    };
    await assert.rejects(h.service().send(REQUEST), errorCode("send_uncertain"));
    assert.equal((await h.ports.authority.getOutboundAttempt(ORG, "reply-1")).status, "pending");
    await assert.rejects(h.reopen().send(REQUEST), errorCode("send_uncertain"));
    assert.equal(h.sent.length, 1);
  });

  it("keeps rejection-state persistence failures closed to automatic resend", async (t) => {
    const h = await harness(t);
    h.faults.send = async () => { throw new SendNotAcceptedError("throttled", "not queued"); };
    t.mock.method(h.ports.authority, "putOutboundAttempt", async () => {
      throw new Error("rejection store unavailable");
    });
    await assert.rejects(h.service().send(REQUEST),
      (error) => error.code === "send_rejection_pending" && error.httpStatus === 503);
    assert.equal((await h.ports.authority.getOutboundAttempt(ORG, "reply-1")).status, "pending");
    h.faults.send = undefined;
    await assert.rejects(h.reopen().send(REQUEST), errorCode("send_uncertain"));
    assert.equal(h.sent.length, 1);
  });

  it("refuses to resend a rejected record containing delivery evidence", async (t) => {
    const h = await harness(t);
    await h.ports.authority.putOutboundAttempt({
      org_id: ORG, client_request_id: "reply-1", thread_id: THREAD,
      status: "rejected", receipt: RECEIPT, now: "2026-08-24T00:00:00.000Z",
    });
    await assert.rejects(h.service().send(REQUEST), errorCode("send_recovery_unavailable"));
    assert.equal(h.sent.length, 0);
  });

  it("does not resend after a response is lost and the process restarts", async (t) => {
    const h = await harness(t);
    h.faults.send = async () => { throw new Error("response lost after delivery"); };
    await assert.rejects(h.service().send(REQUEST), errorCode("send_uncertain"));
    const pending = await h.ports.authority.getOutboundAttempt(ORG, REQUEST.client_request_id);
    assert.equal(pending.status, "pending");
    assert.ok(pending.recovery_hash);
    await assert.rejects(h.reopen().send(REQUEST), errorCode("send_uncertain"));
    assert.equal(h.sent.length, 1);
    assert.equal(h.ingested.length, 0);
  });

  it("recovers accepted content and attachment bytes after restart without resending", async (t) => {
    const h = await harness(t);
    h.faults.ingest = true;
    const bytes = Buffer.from([0, 1, 127, 128, 255]);
    await assert.rejects(h.service().send({
      ...REQUEST,
      attachments: [{ filename: "proof.png", media_type: "image/png", data_base64: bytes.toString("base64") }],
    }), errorCode("send_recovery_pending"));
    assert.equal((await h.ports.authority.getOutboundAttempt(ORG, "reply-1")).status, "accepted");
    h.faults.ingest = false;
    h.faults.bind = true;
    const result = await h.reopen().send({ ...REQUEST, text: "must not replace original" });
    assert.equal(result.accepted, true);
    assert.equal(result.rpc_id, RECEIPT.rpc_id);
    assert.equal(h.sent.length, 1);
    const record = h.ingested[0].records[0];
    assert.equal(record.external_id, "oc_1:out:om_1");
    assert.equal(record.content.find((part) => part.role === "body").text, REQUEST.text);
    const attachment = record.content.find((part) => part.role === "attachment");
    assert.deepEqual(Buffer.from(attachment.bytes), bytes);
    assert.equal(attachment.source_filename, "proof.png");
    const saved = await h.ports.authority.getOutboundAttempt(ORG, "reply-1");
    assert.equal(saved.status, "sent");
    assert.deepEqual(saved.receipt, RECEIPT);
    const replay = await h.service().send(REQUEST);
    assert.equal(replay.item.event.id, result.item.event.id);
    assert.equal(replay.rpc_id, result.rpc_id);
    assert.equal(h.sent.length, 1);
  });

  it("repairs aliases after ingestion committed but finalization failed", async (t) => {
    const h = await harness(t);
    t.mock.method(h.ports.authority, "bindSourceIdentityAliases", async () => {
      throw new Error("alias store unavailable");
    });
    await assert.rejects(h.service().send(REQUEST), errorCode("send_recovery_pending"));
    const result = await h.reopen().send(REQUEST);
    assert.equal(result.accepted, true);
    assert.equal(h.sent.length, 1);
    assert.equal((await h.ports.authority.listInbox(ORG)).length, 1);
    const saved = await h.ports.authority.getOutboundAttempt(ORG, "reply-1");
    assert.equal(saved.status, "sent");
    assert.deepEqual(saved.channel_message_ids, ["om_1", "om_2"]);
    const alias = await h.ports.authority.findBySourceIdentity({
      org_id: ORG, source: "feishu", external_id: "oc_1:om_2",
    });
    assert.equal(alias.id, result.item.event.id);
  });

  it("keeps an uncertain claim if the accepted receipt cannot be persisted", async (t) => {
    const h = await harness(t);
    t.mock.method(h.ports.authority, "putOutboundAttempt", async () => {
      throw new Error("receipt store unavailable");
    });
    await assert.rejects(h.service().send(REQUEST), errorCode("send_recovery_pending"));
    const restarted = h.reopen();
    assert.equal((await h.ports.authority.getOutboundAttempt(ORG, "reply-1")).status, "pending");
    await assert.rejects(restarted.send(REQUEST), errorCode("send_uncertain"));
    assert.equal(h.sent.length, 1);
  });

  it("allows only one independent service to send a shared request", async (t) => {
    const h = await harness(t);
    const put = h.ports.blobs.put.bind(h.ports.blobs);
    let prepared = 0;
    let release;
    const bothPrepared = new Promise((resolve) => { release = resolve; });
    t.mock.method(h.ports.blobs, "put", async (...args) => {
      await put(...args);
      if (prepared < 2) {
        prepared += 1;
        if (prepared === 2) release();
        await bothPrepared;
      }
    });
    let finish;
    let started;
    const ready = new Promise((resolve) => { started = resolve; });
    h.faults.send = () => {
      started();
      return new Promise((resolve) => { finish = resolve; });
    };
    const results = Promise.allSettled([h.service().send(REQUEST), h.service().send(REQUEST)]);
    await ready;
    finish(RECEIPT);
    const settled = await results;
    assert.ok(settled.some((result) => result.status === "fulfilled" && result.value.accepted));
    for (const result of settled.filter((result) => result.status === "rejected")) {
      assert.equal(result.reason.code, "send_uncertain");
    }
    assert.equal(h.sent.length, 1);
  });

  it("coalesces same-thread requests but rejects another thread using an inflight key", async (t) => {
    const h = await harness(t);
    const service = h.service();
    const first = service.send(REQUEST);
    const same = service.send(REQUEST);
    await assert.rejects(service.send({ ...REQUEST, thread_id: "feishu:oc_2" }), errorCode("invalid_reply"));
    const [a, b] = await Promise.all([first, same]);
    assert.equal(a.item.event.id, b.item.event.id);
    await assert.rejects(h.service().send({ ...REQUEST, thread_id: "feishu:oc_2" }), errorCode("invalid_reply"));
    assert.equal(h.sent.length, 1);
  });

  it("does not claim a request before sender binding and recovery storage succeed", async (t) => {
    const h = await harness(t);
    h.faults.bind = true;
    await assert.rejects(h.service().send(REQUEST), /sender unavailable/);
    assert.equal(await h.ports.authority.getOutboundAttempt(ORG, "reply-1"), null);
    h.faults.bind = false;
    const put = t.mock.method(h.ports.blobs, "put", async () => { throw new Error("disk full"); });
    await assert.rejects(h.service().send(REQUEST), /disk full/);
    assert.equal(await h.ports.authority.getOutboundAttempt(ORG, "reply-1"), null);
    assert.equal(h.sent.length, 0);
    put.mock.restore();
    assert.equal((await h.service().send(REQUEST)).accepted, true);
  });

  it("keeps a durable claim when the channel does not confirm acceptance", async (t) => {
    const h = await harness(t);
    h.faults.send = async () => ({ accepted: false });
    await assert.rejects(h.service().send(REQUEST), errorCode("send_uncertain"));
    await assert.rejects(h.reopen().send(REQUEST), errorCode("send_uncertain"));
    assert.equal(h.sent.length, 1);
  });

  it("does not reclaim old ambiguous attempts or resend legacy accepted attempts", async (t) => {
    const h = await harness(t);
    for (const status of ["pending", "failed", "accepted"]) {
      const id = `legacy-${status}`;
      await h.ports.authority.putOutboundAttempt({
        org_id: ORG, client_request_id: id, thread_id: THREAD, status,
        now: "2000-01-01T00:00:00.000Z",
      });
      await assert.rejects(h.reopen().send({ ...REQUEST, client_request_id: id }),
        errorCode(status === "accepted" ? "send_recovery_unavailable" : "send_uncertain"));
    }
    assert.equal(h.sent.length, 0);
  });

  it("generates a durable key when the caller omits one", async (t) => {
    const h = await harness(t);
    const result = await h.service().send({ thread_id: THREAD, text: "hello" });
    assert.ok(result.client_request_id);
    assert.equal(h.sent[0].idempotency_key, result.client_request_id);
    assert.equal((await h.ports.authority.getOutboundAttempt(ORG, result.client_request_id)).status, "sent");
  });

  it("never resends a malformed sent attempt with no event", async (t) => {
    const h = await harness(t);
    await h.ports.authority.putOutboundAttempt({
      org_id: ORG, client_request_id: "reply-1", thread_id: THREAD, status: "sent",
      now: "2026-08-24T00:00:00.000Z",
    });
    await assert.rejects(h.service().send(REQUEST), errorCode("send_recovery_unavailable"));
    assert.equal(h.sent.length, 0);
  });

  it("rejects corrupted and wrong-organization recovery payloads without egress", async (t) => {
    const h = await harness(t);
    h.faults.ingest = true;
    await assert.rejects(h.service().send(REQUEST), errorCode("send_recovery_pending"));
    const attempt = await h.ports.authority.getOutboundAttempt(ORG, "reply-1");
    await assert.rejects(loadReplyRecovery(h.ports.blobs, attempt.recovery_hash, "another-org"), /invalid/);
    t.mock.method(h.ports.blobs, "get", async () => Buffer.from("{}"));
    await assert.rejects(h.reopen().send(REQUEST), /hash mismatch/);
    assert.equal(h.sent.length, 1);
  });
});
