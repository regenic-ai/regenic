const assert = require("node:assert/strict");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { it } = require("node:test");
const { SqliteSplitAuthorityStore } = require("@regenic/authority-store/sqlite");
const { FsBlobStore } = require("@regenic/blob-store");
const { SqliteContextVectorIndex } = require("@regenic/vector-index");
const { SqliteContextLexicalIndex } = require("@regenic/lexical-index");
const { IngestionService, embeddingGeneration, EmbeddingError, MemoryContextRetrieverRegistry } = require("@regenic/domain");
const {
  AuthorityContextEvidenceSource, ContextEmbeddingWorker, ContextSearcher, contextSearchRequest,
  DeterministicContextEngine, IndexedEventRetriever, HybridEventRetriever,
} = require("../dist");

const descriptor = {
  model_id: "synthetic/search", model_revision: "a".repeat(40), tokenizer_revision: "a".repeat(40),
  dimensions: 2, max_input_tokens: 128, query_template: "query: ", document_template: "doc: ",
  normalization: "l2", similarity: "cosine", numeric_format: "float32",
};
const generation = embeddingGeneration(descriptor, 32, 1024);
const body = (text) => ({ role: "body", media_type: "text/plain", text });
const file = (name, text, media = "text/plain") => ({
  role: "attachment", source_filename: name, media_type: media,
  bytes: Buffer.from(text),
});

async function fixture(t, providerOverrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "regenic-unified-search-"));
  const authority = await SqliteSplitAuthorityStore.open(join(root, "authority.db"));
  const blobs = new FsBlobStore(join(root, "blobs"));
  const index = new SqliteContextVectorIndex(join(root, "vector.db"));
  const lexical = new SqliteContextLexicalIndex(join(root, "lexical.db"));
  const source = new AuthorityContextEvidenceSource(authority, blobs, true);
  let offline = false;
  const provider = {
    descriptor,
    async countTokens(texts) { if (offline) throw new EmbeddingError("unavailable", true); return texts.map((text) => Math.ceil(text.length / 4) + 5); },
    async embed(texts, mode) { return texts.map(() => mode === "query" ? [1, 0] : [0, 1]); },
    async processAttachment(input) {
      const marker = Buffer.from(input.bytes).toString();
      return marker.includes("visual")
        ? { text: undefined, vectors: [marker.includes("target") ? [1, 0] : [0, 1]] }
        : { text: "Extracted nebula invoice terms.", vectors: [] };
    },
    ...providerOverrides,
  };
  const blocked = new Set();
  const retrievers = new MemoryContextRetrieverRegistry();
  retrievers.register(new HybridEventRetriever(new IndexedEventRetriever(lexical), provider, index, generation, index));
  const engine = new DeterministicContextEngine({
    source, artifacts: authority, retrievers,
    policy: {
      metadata_only: true,
      async policyHash() { return "b".repeat(64); },
      async visible(input) { return !blocked.has(input.resource.resource_id); },
      async protectedEventIds() { return []; },
      async canReplay() { return true; },
    },
  });
  const worker = new ContextEmbeddingWorker("org", source, provider, index, index, generation, index);
  t.after(async () => {
    await worker.stop(); index.close(); lexical.close(); await authority.close();
    await rm(root, { recursive: true, force: true });
  });
  const ingestion = new IngestionService(blobs, authority);
  let sequence = 0;
  return {
    source, index, worker, blocked,
    offline() {
      offline = true;
      provider.countTokens = async () => { throw new EmbeddingError("unavailable", true); };
    },
    async ingest(id, content, operation = "create") {
      const result = await ingestion.ingest({
        schema_version: "1.0", connector_id: "synthetic", org_id: "org", delivery_id: `${sequence++}`,
        received_at: "2026-10-30T00:00:00.000Z",
        records: [{
          source: "synthetic", external_id: id, operation,
          occurred_at: new Date(Date.parse("2026-10-30T00:00:00.000Z") + sequence * 1000).toISOString(),
          actor: { id: "actor" }, scope: { id: "thread" }, type: "message",
          ...(content ? { content } : {}),
        }],
      });
      assert.equal(result.records[0].status, "accepted");
      const read = await source.openRead({ org_id: "org" });
      return read.events.find((event) => event.event.external_id === id && event.event.operation === operation).event;
    },
    async search(query, kind = "all", limit = 20) {
      return new ContextSearcher(engine).search(contextSearchRequest({ query, kind, limit }, {
        id: `query-${sequence++}`, org_id: "org", principal: { actor_type: "human", actor_id: "owner" },
      }));
    },
  };
}

it("retains a semantic message in the 50-candidate window despite 50 mixed attachment keyword hits", async (t) => {
  const f = await fixture(t, {
    async embed(texts, mode) {
      return texts.map((text) => mode === "query" || text === "stellar answer" ? [1, 0] : [0, 1]);
    },
  });
  for (let index = 0; index < 50; index++) {
    await f.ingest(`mixed-${index}`, [body("ordinary"), file("report.pdf", "%PDF synthetic", "application/pdf")]);
  }
  const message = await f.ingest("message", [body("stellar answer")]);
  assert.equal((await f.worker.runOnce({ max_jobs: 60 })).processed, 51);
  const messages = await f.search("nebula", "messages", 10);
  assert.deepEqual(messages.items.map((hit) => hit.event_id), [message.event_id]);
  assert.deepEqual(messages.items[0].matches.map((match) => [match.kind, match.via]), [["message", ["semantic"]]]);
  const files = await f.search("nebula", "files", 10);
  assert.equal(files.items.length, 10);
  assert.ok(files.items.every((hit) => hit.matches.every((match) => match.kind === "file" && match.via.includes("text"))));
  assert.equal((await f.search("nebula", "all", 10)).items.length, 10);
});

it("finds PDF keywords split by the unchanged 32-token worker chunks, including offline", async (t) => {
  const extracted = `${"x".repeat(24)} nebula invoice`;
  const f = await fixture(t, {
    async countTokens(texts) { return texts.map((text) => Array.from(text).length + 5); },
    async processAttachment(input) {
      return { text: input.source_filename === "control.pdf" ? "nebula invoice" : extracted, vectors: [] };
    },
  });
  const event = await f.ingest("split", [body("ordinary"), file("report.pdf", "%PDF synthetic", "application/pdf")]);
  await f.ingest("control", [body("ordinary"), file("control.pdf", "%PDF control", "application/pdf")]);
  assert.equal((await f.worker.runOnce({ max_jobs: 2 })).processed, 2);
  const input = {
    org_id: "org", generation: generation.id, authorized: [{ event_id: event.event_id, content_hash: event.content_hash }],
    query_vector: [1, 0], limit: 50, query: "ne", search_kind: "files",
  };
  const fragments = (await f.index.matchAuthorized(input)).matched[0].search_matches;
  assert.ok(fragments.some((hit) => hit.origin.text.endsWith(" ne")));
  assert.ok(fragments.every((hit) => !hit.lexical), "partial chunk tokens must not become file keywords");
  const online = await f.search("nebula", "files");
  f.offline();
  const offline = await f.search("NEBULA", "files");
  assert.ok(offline.degradation_flags.includes("embedding_unavailable"));
  for (const result of [online, offline]) {
    assert.equal(result.items.length, 2);
    const hit = result.items.find((hit) => hit.event_id === event.event_id).matches[0];
    assert.equal(hit.part_index, 1);
    assert.deepEqual(hit.via, ["text"]);
    assert.ok(hit.snippet.includes("nebula"));
    assert.equal(extracted.slice(hit.start, hit.end), hit.snippet);
    assert.ok(result.items.some((item) => item.matches[0].filename === "control.pdf"));
  }
});

it("finds filename-only and empty files, keeps part indexes distinct and filters before the result budget", async (t) => {
  const f = await fixture(t);
  await f.ingest("files", [body("unrelated body"), file("budget.csv", ""), file("budget.csv", "")]);
  const all = await f.search("budget.csv");
  assert.equal(all.items.length, 1);
  assert.deepEqual(all.items[0].matches.map((match) => [match.part_index, match.filename, match.via]), [
    [1, "budget.csv", ["filename"]], [2, "budget.csv", ["filename"]],
  ]);
  assert.equal((await f.search("budget.csv", "messages")).items.length, 0);
  assert.equal((await f.search("budget.csv", "files")).items[0].matches.length, 2);
  assert.equal(all.items[0].matches[0].start, undefined);
  await assert.rejects(f.search(" "), /Invalid search/);
});

it("returns bounded exact file-local Unicode text ranges even for large stored attachments", async (t) => {
  const f = await fixture(t);
  const text = `${"x ".repeat(20_000)}😀 nebula invoice ${"y ".repeat(20_000)}`;
  await f.ingest("large", [body("message-only"), file("large.txt", text), file("other.txt", "not the same content")]);
  const result = await f.search("nebula", "files");
  assert.equal(result.items.length, 1, JSON.stringify(result));
  const match = result.items[0].matches[0];
  assert.equal(match.part_index, 1);
  assert.equal(match.filename, "large.txt");
  assert.equal(text.slice(match.start, match.end), match.snippet);
  assert.ok(match.snippet.includes("nebula"));
  assert.ok(Array.from(match.snippet).length <= 480);
  assert.ok(JSON.stringify(result).length < 8_000);
  assert.equal((await f.search("nebula", "messages")).items.length, 0);
});

it("unifies extracted keywords and visual semantics without attributing another attachment", async (t) => {
  const f = await fixture(t);
  await f.ingest("mixed", [
    body("ordinary message"),
    file("wrong.png", "wrong visual", "image/png"),
    file("report.pdf", "%PDF synthetic", "application/pdf"),
    file("target.png", "target visual", "image/png"),
  ]);
  assert.equal((await f.worker.runOnce()).processed, 1);
  const keyword = await f.search("nebula", "files");
  const report = keyword.items[0].matches.find((match) => match.filename === "report.pdf");
  assert.ok(report.via.includes("text"));
  assert.equal("Extracted nebula invoice terms.".slice(report.start, report.end), report.snippet);
  assert.equal(keyword.items[0].matches.some((match) => match.filename === "wrong.png"), false);
  const semantic = await f.search("landscape", "files");
  assert.deepEqual(semantic.items[0].matches.map((match) => [match.part_index, match.filename, match.via]), [
    [3, "target.png", ["visual"]],
  ]);
  assert.equal(semantic.items[0].matches[0].start, undefined);
  assert.equal(semantic.items[0].matches[0].snippet, undefined);
});

it("searches completed extracted keywords with the provider offline and reports degradation", async (t) => {
  const f = await fixture(t);
  await f.ingest("offline", [file("report.pdf", "%PDF synthetic", "application/pdf")]);
  assert.equal((await f.worker.runOnce()).processed, 1);
  f.offline();
  const result = await f.search("nebula", "files");
  assert.equal(result.items.length, 1);
  assert.deepEqual(result.items[0].matches[0].via, ["text"]);
  assert.ok(result.degradation_flags.includes("embedding_unavailable"));
});

it("does not expose hidden filenames or old attachment content after revisions and deletion", async (t) => {
  const f = await fixture(t);
  const hidden = await f.ingest("hidden", [body("hidden"), file("classified-nebula.txt", "private-nebula")]);
  f.blocked.add(hidden.event_id);
  const visible = await f.ingest("visible", [body("visible"), file("oldname-nebula.txt", "invoice")]);
  const visibleResult = await f.search("nebula", "files");
  assert.equal(visibleResult.items.length, 1, JSON.stringify(visibleResult));
  const result = await f.search("classified");
  assert.equal(result.items.length, 0);
  assert.equal(JSON.stringify(result).includes("classified-nebula"), false);
  await f.ingest("visible", [body("replacement"), file("new.txt", "invoice")], "revise");
  assert.equal((await f.search("oldname", "files")).items.length, 0);
  await f.ingest("visible", undefined, "tombstone");
  assert.equal((await f.search("invoice", "files")).items.length, 0);
  assert.ok(visible.content_hash);
});

it("deduplicates filename, stored-text and semantic matches for one attachment", async (t) => {
  const f = await fixture(t);
  await f.ingest("dedup", [body("ordinary"), file("nebula.pdf", "%PDF synthetic", "application/pdf")]);
  await f.worker.runOnce();
  const result = await f.search("nebula", "files");
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].matches.length, 1);
  assert.deepEqual(result.items[0].matches[0].via, ["filename", "text"], JSON.stringify(result.items[0].matches));
});

it("keeps legacy unlocated semantic hits at Event level instead of guessing an attachment", async (t) => {
  const f = await fixture(t);
  await f.ingest("legacy", [body("ordinary"), file("target.png", "target visual", "image/png")]);
  await f.worker.runOnce();
  const match = f.index.matchAuthorized.bind(f.index);
  f.index.matchAuthorized = async (input) => {
    const result = await match(input);
    for (const hit of result.matched) delete hit.search_matches;
    return result;
  };
  const all = await f.search("landscape");
  assert.deepEqual(all.items[0].matches, [{ kind: "event", via: ["semantic"] }]);
  assert.equal((await f.search("landscape", "files")).items.length, 0);
});

it("rejects a vector origin bound to the wrong attachment hash", async (t) => {
  const f = await fixture(t);
  await f.ingest("binding", [body("ordinary"), file("target.png", "target visual", "image/png")]);
  await f.worker.runOnce();
  const match = f.index.matchAuthorized.bind(f.index);
  f.index.matchAuthorized = async (input) => {
    const result = await match(input);
    result.matched[0].search_matches[0].origin.content_hash = "f".repeat(64);
    return result;
  };
  await assert.rejects(f.search("landscape"), (error) => error.code === "invalid_candidate");
});
