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
const TOTAL = 260;
const ANCHOR = 30;

function minute(index) {
  return new Date(Date.UTC(2026, 9, 20, 0, index)).toISOString();
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), "regenic-thread-context-"));
  const authority = new SqliteAuthorityStore(join(root, "authority.db"));
  const blobs = new FsBlobStore(join(root, "blobs"));
  t.after(async () => {
    authority.close();
    await rm(root, { recursive: true, force: true });
  });
  const result = await new IngestionService(blobs, authority).ingest({
    schema_version: INGEST_SCHEMA_VERSION,
    connector_id: "native-local",
    org_id: ORG,
    delivery_id: "delivery-thread",
    received_at: minute(TOTAL),
    records: Array.from({ length: TOTAL }, (_, index) => ({
      operation: "create",
      source: "synthetic-chat",
      external_id: `customer-a:${index}`,
      ...(index === ANCHOR ? { parent_external_id: "customer-a:0" } : {}),
      occurred_at: minute(index),
      actor: { id: index === 0 ? "owner" : "customer" },
      scope: { id: "customer-a" },
      type: "message",
      content: index === ANCHOR && options.attachmentAnchor
        ? [{
            role: "attachment",
            media_type: "image/png",
            source_filename: "anchor.png",
            external_locator: "source://anchor.png",
          }]
        : [{ role: "body", media_type: "text/plain", text: `message ${index}` }],
    })),
  });
  const ids = result.records.map((record) => record.event_id);
  const anchor = await authority.getEvent(ORG, ids[ANCHOR]);
  const runtime = {
    orgId: () => ORG,
    requireHost: () => ({ get: (name) => ({ authority, blobs })[name] }),
  };
  return { channel: new PersonalWorkChannel(runtime, {}), ids, threadId: anchor.thread_id };
}

const texts = (lines) => lines.map((line) => line.text);

describe("work thread context", () => {
  it("reads past the 200-row inbox page cap", async (t) => {
    const { channel, threadId } = await fixture(t);
    const all = await channel.threadContextLines(threadId, { fetchLimit: 400 });
    assert.equal(all.overflow, false);
    assert.equal(all.lines.length, TOTAL);
    const capped = await channel.threadContextLines(threadId, { fetchLimit: 250 });
    assert.equal(capped.overflow, true);
    assert.equal(capped.lines[0].text, "message 10");
  });

  it("anchors on the trigger and its reply target outside the recent tail", async (t) => {
    const { channel, ids, threadId } = await fixture(t);
    const { lines, overflow } = await channel.threadContextLines(threadId, {
      fetchLimit: 40,
      anchorEventId: ids[ANCHOR],
    });
    assert.equal(overflow, true);
    assert.deepEqual(texts(lines), [
      "message 0",
      ...Array.from({ length: 21 }, (_, index) => `message ${index + 10}`),
      ...Array.from({ length: 40 }, (_, index) => `message ${index + 220}`),
    ]);
    const byText = new Map(lines.map((line) => [line.text, line]));
    assert.equal(byText.get(`message ${ANCHOR}`).rank, 0);
    assert.equal(byText.get(`message ${ANCHOR}`).event_id, ids[ANCHOR]);
    assert.equal(byText.get("message 0").rank, 1);
    assert.equal(byText.get(`message ${ANCHOR}`).reply_to, byText.get("message 0").speaker);
    assert.equal(byText.get("message 10").gap_before, true);
    assert.equal(byText.get("message 220").gap_before, true);
    assert.ok(!byText.get("message 221").gap_before);
  });

  it("keeps an attachment-only trigger as the evidence anchor", async (t) => {
    const { channel, ids, threadId } = await fixture(t, {
      attachmentAnchor: true,
    });
    const { lines } = await channel.threadContextLines(threadId, {
      fetchLimit: 40,
      anchorEventId: ids[ANCHOR],
    });
    const anchor = lines.find((line) => line.event_id === ids[ANCHOR]);
    assert.equal(anchor.text, "[Attachment: anchor.png]");
    assert.equal(anchor.rank, 0);
  });
});
