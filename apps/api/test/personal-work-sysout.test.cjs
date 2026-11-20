const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { describe, it } = require("node:test");
const { SqliteAuthorityStore } = require("@regenic/authority-store/sqlite");
const { FsBlobStore } = require("@regenic/blob-store");
const { INGEST_SCHEMA_VERSION, IngestionService } = require("@regenic/domain");
const { PersonalWorkChannel } = require("../dist/personal-work-channel");

const ORG = "local-owner";
const MESSAGES = 240;
const ENDED_AT = 5;
const OPEN_AT = MESSAGES + 1;

function minute(index) {
  return new Date(Date.UTC(2026, 9, 20, 0, index)).toISOString();
}

function surface(turn, activity) {
  return {
    role: "metadata",
    media_type: "application/vnd.regenic.surface+json",
    text: JSON.stringify({
      channel: "dsh",
      kind: "system",
      direction: "inbound",
      ...(activity ? { activity } : {}),
      turn,
    }),
  };
}

function record(index, extra) {
  return {
    operation: "create",
    source: "dsh",
    external_id: `session-a:${index}`,
    occurred_at: minute(index),
    actor: { id: index === OPEN_AT ? "assistant" : "user" },
    scope: { id: "session-a" },
    type: extra?.type ?? "message",
    content: extra?.content ?? [{
      role: "body",
      media_type: "text/plain",
      text: `message ${index}`,
    }],
  };
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "regenic-sysout-"));
  const authority = new SqliteAuthorityStore(join(root, "authority.db"));
  const blobs = new FsBlobStore(join(root, "blobs"));
  let reads = 0;
  const get = blobs.get.bind(blobs);
  blobs.get = async (hash) => {
    reads += 1;
    return get(hash);
  };
  t.after(async () => {
    authority.close();
    await rm(root, { recursive: true, force: true });
  });
  const records = Array.from({ length: MESSAGES }, (_, index) => record(index));
  records[ENDED_AT] = record(ENDED_AT, {
    type: "thread_status",
    content: [
      { role: "body", media_type: "text/plain", text: "SEND_AND_CLOSE" },
      surface({ state: "ended", ok: true, reason: "completed" }),
    ],
  });
  records.push(record(MESSAGES, {
    content: [{ role: "body", media_type: "text/plain", text: "still talking" }],
  }));
  records.push(record(OPEN_AT, {
    type: "thread_status",
    content: [
      { role: "body", media_type: "text/plain", text: "Still working." },
      surface({ state: "open" }, "working"),
    ],
  }));
  await new IngestionService(blobs, authority).ingest({
    schema_version: INGEST_SCHEMA_VERSION,
    connector_id: "dsh-session",
    org_id: ORG,
    delivery_id: "delivery-sysout",
    received_at: minute(OPEN_AT),
    records,
  });
  const head = await authority.listInbox(ORG, {
    thread_ids: ["dsh:session-a"],
    siblings: true,
    limit: 1,
  });
  const runtime = {
    orgId: () => ORG,
    requireHost: () => ({ get: (name) => ({ authority, blobs })[name] }),
  };
  return {
    channel: new PersonalWorkChannel(runtime, {}),
    threadId: head[0].event.thread_id,
    reads: () => reads,
    resetReads: () => {
      reads = 0;
    },
  };
}

describe("sysout reap reads", () => {
  it("reaps from an older ended status without reading the whole session", async (t) => {
    const { channel, threadId, reads, resetReads } = await fixture(t);
    resetReads();
    const inspected = await channel.inspectSysout(threadId);
    assert.equal(inspected.scan.liveTurn, "open");
    assert.equal(inspected.scan.liveActivity, "working");
    assert.equal(inspected.scan.inboxEnded, true);
    assert.equal(inspected.scan.endedSummary, "SEND_AND_CLOSE");
    assert.equal(inspected.transcript?.activity, "working");
    assert.ok(reads() < 10, `expected a handful of blob reads, got ${reads()}`);

    resetReads();
    const transcript = await channel.readTranscript(threadId);
    assert.equal(transcript?.activity, "working");
    assert.equal(transcript?.turn?.state, "open");
    assert.ok(reads() < 10, `expected a handful of blob reads, got ${reads()}`);
  });
});
