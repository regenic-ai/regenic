const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  createGenericImport,
  IngestionService,
  MemoryAuthorityStore,
  MemoryBlobStore,
} = require("../dist");

const input = {
  connector_id: "generic-import",
  org_id: "local-owner",
  source: "file-import",
  received_at: "2026-08-12T00:00:00.000Z",
  mapping: {
    external_id: "id",
    occurred_at: "timestamp",
    text: "body",
    actor_id: "author",
    scope_name: "folder",
  },
  defaults: { actor_id: "local-owner", scope_id: "personal", type: "text" },
};

describe("createGenericImport", () => {
  it("maps CSV rows with quoted delimiters and reports invalid rows", () => {
    const result = createGenericImport({
      ...input,
      format: "csv",
      data: [
        "id,timestamp,body,author,folder",
        'one,2026-08-11T23:00:00.000Z,"Hello, world",alice,inbox',
        "two,not-a-time,Broken row,,",
      ].join("\n"),
    });

    assert.equal(result.batches[0].records.length, 1);
    assert.equal(result.batches[0].records[0].external_id, "one");
    assert.equal(result.batches[0].records[0].content[0].text, "Hello, world");
    assert.deepEqual(result.errors, [
      { line: 3, code: "invalid_row", message: "Invalid datetime" },
    ]);
  });

  it("maps valid JSONL lines while isolating malformed lines", () => {
    const data = [
      '{"id":"one","timestamp":"2026-08-11T23:00:00.000Z","body":"First"}',
      "not-json",
      '{"id":"two","timestamp":"2026-08-11T23:01:00.000Z","body":"Second"}',
    ].join("\n");
    const result = createGenericImport({ ...input, format: "jsonl", data });

    assert.deepEqual(result.batches[0].records.map((record) => record.external_id), ["one", "two"]);
    assert.equal(result.errors[0].line, 2);
    assert.equal(result.errors[0].code, "invalid_json");
  });

  it("uses stable delivery identity for identical file bytes", () => {
    const file = "id,timestamp,body\none,2026-08-11T23:00:00.000Z,Body";
    const first = createGenericImport({ ...input, format: "csv", data: file });
    const replay = createGenericImport({ ...input, format: "csv", data: file });

    assert.equal(first.file_hash, replay.file_hash);
    assert.equal(first.batches[0].delivery_id, replay.batches[0].delivery_id);
  });

  it("replays imported source identities through the canonical ingestion service", async () => {
    const imported = createGenericImport({
      ...input,
      format: "jsonl",
      data: '{"id":"one","timestamp":"2026-08-11T23:00:00.000Z","body":"Body"}',
    });
    const service = new IngestionService(
      new MemoryBlobStore(),
      new MemoryAuthorityStore(),
    );

    const first = await service.ingest(imported.batches[0]);
    const replay = await service.ingest(imported.batches[0]);

    assert.equal(first.records[0].status, "accepted");
    assert.equal(replay.records[0].status, "duplicate");
    assert.equal(replay.records[0].event_id, first.records[0].event_id);
  });

  it("rejects text after a closing CSV quote", () => {
    const result = createGenericImport({
      ...input,
      format: "csv",
      data: 'id,timestamp,body\none,2026-08-11T23:00:00.000Z,"Body"tail',
    });

    assert.deepEqual(result.batches, []);
    assert.deepEqual(result.errors, [
      { line: 2, code: "invalid_csv", message: "Unexpected data after closing quote" },
    ]);
  });

  it("splits valid records into stable bounded batches", () => {
    const result = createGenericImport({
      ...input,
      format: "jsonl",
      max_records_per_batch: 1,
      data: [
        '{"id":"one","timestamp":"2026-08-11T23:00:00.000Z","body":"First"}',
        '{"id":"two","timestamp":"2026-08-11T23:01:00.000Z","body":"Second"}',
      ].join("\n"),
    });

    assert.deepEqual(result.batches.map((batch) => batch.records.length), [1, 1]);
    assert.notEqual(result.batches[0].delivery_id, result.batches[1].delivery_id);
  });

  it("rejects files that exceed the configured byte limit", () => {
    const result = createGenericImport({
      ...input,
      format: "csv",
      data: "id,timestamp,body",
      max_bytes: 1,
    });

    assert.deepEqual(result.batches, []);
    assert.deepEqual(result.errors, [
      { code: "file_too_large", message: "File exceeds 1 byte limit" },
    ]);
  });
});