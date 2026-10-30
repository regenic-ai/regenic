const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { createServer } = require("node:http");
const { EmbeddingError } = require("@regenic/domain");
const { EMBEDDINGGEMMA_2, LocalHttpEmbeddingProvider, embeddingConfigFromEnv } = require("../dist");

const vector = () => [1, ...Array(767).fill(0)];
function provider(reply, timeout = 1000) {
  return new LocalHttpEmbeddingProvider({ base_url: "http://127.0.0.1:8765", timeout_ms: timeout, fetch: reply });
}
function response(value) {
  return new Response(JSON.stringify({ descriptor: EMBEDDINGGEMMA_2, ...value }), { headers: { "content-type": "application/json" } });
}

describe("local embedding provider", () => {
  it("separates modes and sends the fixed descriptor without duplicating prompts", async () => {
    const requests = [];
    const subject = provider(async (url, init) => {
      requests.push({ url, ...JSON.parse(init.body), redirect: init.redirect });
      return url.endsWith("/tokens") ? response({ counts: [12] }) : response({ vectors: [vector()] });
    });
    assert.deepEqual(await subject.countTokens(["中文"], "document"), [12]);
    assert.deepEqual(await subject.embed(["question"], "query"), [vector()]);
    assert.equal(requests[0].mode, "document");
    assert.deepEqual(requests[0].texts, ["中文"]);
    assert.equal(requests[1].mode, "query");
    assert.equal(requests[1].descriptor.model_revision, "914f7f89142e33e77833254d9c9b90c3cef7303b");
    assert.equal(requests[1].redirect, "error");
    assert.equal(subject.descriptor.dimensions, 768);
  });

  it("rejects model, dimensions, norm, token shape and non-finite mismatches", async () => {
    const cases = [
      [{ descriptor: { ...EMBEDDINGGEMMA_2, model_revision: "a".repeat(40) }, vectors: [vector()] }, "model_mismatch"],
      [{ descriptor: undefined, vectors: [vector()] }, "model_mismatch"],
      [{ vectors: [[1, 0]] }, "invalid_response"],
      [{ vectors: [Array(768).fill(0)] }, "invalid_response"],
      [{ vectors: [[null, ...Array(767).fill(0)]] }, "invalid_response"],
      [{ vectors: [vector(), vector()] }, "invalid_response"],
    ];
    for (const [body, code] of cases) {
      await assert.rejects(provider(async () => response(body)).embed(["text"], "document"),
        (error) => error instanceof EmbeddingError && error.code === code);
    }
    await assert.rejects(provider(async () => response({ counts: [0] })).countTokens(["text"], "document"),
      (error) => error.code === "invalid_response");
  });

  it("sends bounded binary attachments only to loopback and validates all extracted material", async () => {
    let called = 0;
    const subject = provider(async (url, init) => {
      called++;
      assert.equal(url, "http://127.0.0.1:8765/attachment");
      const body = JSON.parse(init.body);
      assert.equal(body.media_type, "application/pdf");
      assert.equal(body.source_filename, "local.pdf");
      assert.equal(Buffer.from(body.bytes_base64, "base64").toString(), "%PDF-local");
      assert.equal(init.redirect, "error");
      return response({ text: "extracted text", vectors: [vector()] });
    });
    assert.deepEqual(await subject.processAttachment({
      media_type: "application/pdf", source_filename: "local.pdf", bytes: Buffer.from("%PDF-local"),
    }), { text: "extracted text", vectors: [vector()] });
    const cached = await subject.processAttachment({
      media_type: "application/pdf", source_filename: "local.pdf", bytes: Buffer.from("%PDF-local"),
    });
    cached.vectors[0][0] = 0;
    assert.equal((await subject.processAttachment({
      media_type: "application/pdf", source_filename: "local.pdf", bytes: Buffer.from("%PDF-local"),
    })).vectors[0][0], 1);
    for (const bytes of [new Uint8Array(), new Uint8Array(16 * 1024 * 1024 + 1)]) {
      await assert.rejects(subject.processAttachment({ media_type: "image/png", bytes }),
        (error) => ["invalid_input", "input_too_large"].includes(error.code));
    }
    assert.equal(called, 1);
    for (const body of [
      { vectors: [] }, { text: "x", vectors: [[1, 0]] },
      { text: "x".repeat(262145), vectors: [] }, { vectors: Array(129).fill(vector()) },
    ]) {
      await assert.rejects(provider(async () => response(body)).processAttachment({
        media_type: "image/png", bytes: Buffer.from("local"),
      }), (error) => ["invalid_input", "invalid_response"].includes(error.code));
    }
    await assert.rejects(provider(async () => new Response("private", { status: 415 })).processAttachment({
      media_type: "application/octet-stream", bytes: Buffer.from("local"),
    }), (error) => error.code === "unsupported_attachment" && !error.retryable);
  });

  it("bounds streaming bodies and classifies HTTP errors without returning upstream text", async () => {
    for (const [status, code, retryable] of [[400, "invalid_input", false], [409, "model_mismatch", false],
      [413, "input_too_large", false], [503, "unavailable", true]]) {
      await assert.rejects(provider(async () => new Response("private upstream text", { status })).embed(["text"], "document"),
        (error) => error.code === code && error.retryable === retryable && !error.message.includes("private"));
    }
    await assert.rejects(provider(async () => new Response("{bad-json")).embed(["text"], "query"),
      (error) => error.code === "invalid_response");
    await assert.rejects(provider(async () => new Response(new Uint8Array(4194305))).embed(["text"], "query"),
      (error) => error.code === "invalid_response");
    const error = await provider(async () => new Response("secret", { status: 503 })).health();
    assert.deepEqual(error, { status: "degraded", error_code: "unavailable" });
  });

  it("bounds the successful attachment cache and never caches failures", async () => {
    let calls = 0;
    const subject = provider(async () => { calls++; return response({ vectors: [vector()] }); });
    const attachment = (index) => ({
      media_type: "image/png", bytes: Buffer.from(`synthetic-${index}`),
    });
    for (let index = 0; index < 129; index++) await subject.processAttachment(attachment(index));
    await subject.processAttachment(attachment(128));
    assert.equal(calls, 129);
    await subject.processAttachment(attachment(0));
    assert.equal(calls, 130);
    let attempts = 0;
    const failing = provider(async () => {
      attempts++;
      return attempts === 1 ? new Response("", { status: 503 }) : response({ vectors: [vector()] });
    });
    await assert.rejects(failing.processAttachment(attachment(0)), (error) => error.code === "unavailable");
    await failing.processAttachment(attachment(0));
    assert.equal(attempts, 2);
  });

  it("bounds inputs before network and supports timeout and cancellation through the body read", async () => {
    let called = false;
    const subject = provider(async () => { called = true; return response({}); });
    for (const texts of [[], Array(33).fill("x"), ["x".repeat(262145)], Array(4).fill("x".repeat(262100))]) {
      await assert.rejects(subject.embed(texts, "query"), (error) => error.code === "invalid_input");
    }
    assert.equal(called, false);
    const hanging = provider(async (_url, init) => new Promise((_resolve, reject) =>
      init.signal.addEventListener("abort", () => reject(new Error("private network error")), { once: true })), 10);
    await assert.rejects(hanging.embed(["text"], "query"), (error) => error.code === "timeout");
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(subject.embed(["text"], "query", abort.signal), (error) => error.code === "cancelled");
  });

  it("times out and cancels an actual HTTP response stalled after headers", async (t) => {
    let received;
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"descriptor":');
      received?.();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(async () => {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    });
    const base_url = `http://127.0.0.1:${server.address().port}`;
    await assert.rejects(new LocalHttpEmbeddingProvider({ base_url, timeout_ms: 100 }).embed(["test"], "query"),
      (error) => error.code === "timeout");
    const started = new Promise((resolve) => { received = resolve; });
    const controller = new AbortController();
    const pending = new LocalHttpEmbeddingProvider({ base_url }).embed(["test"], "query", controller.signal);
    await started;
    controller.abort();
    await assert.rejects(pending, (error) => error.code === "cancelled");
  });

  it("defaults off and rejects public endpoints, floating models and invalid configuration", () => {
    assert.equal(embeddingConfigFromEnv({}), undefined);
    for (const url of ["https://example.com", "http://localhost:8765", "http://127.0.0.1:8765/path", "http://127.0.0.1:8765/?x=1"]) {
      assert.throws(() => new LocalHttpEmbeddingProvider({ base_url: url }), /numeric loopback/);
    }
    assert.throws(() => embeddingConfigFromEnv({ REGENIC_EMBEDDING_DRIVER: "other" }), /Unsupported/);
    assert.throws(() => embeddingConfigFromEnv({
      REGENIC_EMBEDDING_DRIVER: "local_http", REGENIC_EMBEDDING_BASE_URL: "http://127.0.0.1:8765",
      REGENIC_EMBEDDING_CHUNK_TOKENS: "0",
    }), /numeric/);
  });
});
