const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  ModelTimeoutError,
  ModelUnavailableError,
  ModelUpstreamError,
} = require("@regenic/domain");
const { createHost } = require("@regenic/plugin-host");
const {
  NoneModelProvider,
  OpenAICompatibleModelProvider,
  modelProviderConfigFromEnv,
  modelProviderPlugin,
} = require("../dist");

function completionRequest(overrides = {}) {
  return {
    messages: [
      { role: "system", content: "Return JSON." },
      { role: "user", content: "Synthetic evidence." },
    ],
    format: "json",
    temperature: 0,
    max_output_tokens: 256,
    ...overrides,
  };
}

function completionResponse(text = '{"answer":"ok"}') {
  return new Response(JSON.stringify({
    model: "test-model-response",
    choices: [{
      message: { role: "assistant", content: text },
      finish_reason: "stop",
    }],
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("model providers", () => {
  it("keeps the none provider explicitly degraded", async () => {
    const provider = new NoneModelProvider();
    assert.deepEqual(await provider.health(), { status: "degraded", driver: "none" });
    await assert.rejects(
      provider.complete(completionRequest()),
      (error) => error instanceof ModelUnavailableError,
    );
  });

  it("sends OpenAI-compatible JSON requests with env-ref credentials", async () => {
    let captured;
    const provider = new OpenAICompatibleModelProvider({
      base_url: "http://127.0.0.1:11434/v1",
      model: "test-model",
      api_key_ref: "env:MODEL_TEST_KEY",
      env: { MODEL_TEST_KEY: "top-secret-test-key" },
      async fetch(url, init) {
        captured = { url, init, body: JSON.parse(init.body) };
        return completionResponse();
      },
    });

    const result = await provider.complete(completionRequest());
    assert.equal(captured.url, "http://127.0.0.1:11434/v1/chat/completions");
    assert.equal(captured.init.redirect, "error");
    assert.equal(captured.init.headers.authorization, "Bearer top-secret-test-key");
    assert.deepEqual(captured.body.response_format, { type: "json_object" });
    assert.equal(captured.body.model, "test-model");
    assert.equal(result.text, '{"answer":"ok"}');
    assert.equal(result.model, "test-model-response");
    assert.equal(result.finish_reason, "stop");
  });

  it("rejects credential-bearing and metadata service URLs", () => {
    assert.throws(
      () => new OpenAICompatibleModelProvider({
        base_url: "https://user:pass@example.test/v1",
        model: "test-model",
      }),
      /numeric loopback/,
    );
    assert.throws(
      () => new OpenAICompatibleModelProvider({
        base_url: "http://169.254.169.254/latest",
        model: "test-model",
      }),
      /numeric loopback/,
    );
    assert.throws(
      () => new OpenAICompatibleModelProvider({
        base_url: "http://model.example/v1",
        model: "test-model",
      }),
      /numeric loopback/,
    );
    assert.throws(
      () => new OpenAICompatibleModelProvider({
        base_url: "https://10.0.0.7/v1",
        model: "test-model",
      }),
      /numeric loopback/,
    );
    assert.throws(
      () => new OpenAICompatibleModelProvider({
        base_url: "https://[fd00::1]/v1",
        model: "test-model",
      }),
      /numeric loopback/,
    );
    assert.throws(
      () => new OpenAICompatibleModelProvider({
        base_url: "http://127.0.0.1:11434/v1",
        model: "test-model",
        api_key_ref: "env:MISSING_KEY",
        env: {},
      }),
      /could not be resolved/,
    );
  });

  it("bounds model responses from headers and streamed bytes", async () => {
    const fromHeader = new OpenAICompatibleModelProvider({
      base_url: "http://127.0.0.1:11434/v1",
      model: "test-model",
      max_response_bytes: 1024,
      async fetch() {
        return new Response("", {
          status: 200,
          headers: { "content-length": "1025" },
        });
      },
    });
    await assert.rejects(
      fromHeader.complete(completionRequest()),
      (error) => error instanceof ModelUpstreamError && /exceeds/.test(error.message),
    );

    const streamed = new OpenAICompatibleModelProvider({
      base_url: "http://127.0.0.1:11434/v1",
      model: "test-model",
      max_response_bytes: 1024,
      async fetch() {
        return new Response("x".repeat(1025), { status: 200 });
      },
    });
    await assert.rejects(
      streamed.complete(completionRequest()),
      (error) => error instanceof ModelUpstreamError && /exceeds/.test(error.message),
    );
  });

  it("classifies timeouts without leaking provider details", async () => {
    const provider = new OpenAICompatibleModelProvider({
      base_url: "http://127.0.0.1:11434/v1",
      model: "test-model",
      api_key_ref: "env:MODEL_TEST_KEY",
      env: { MODEL_TEST_KEY: "never-echo-this-secret" },
      timeout_ms: 1,
      fetch(_url, init) {
        return new Promise((_resolve, reject) => {
          const holdOpen = setTimeout(() => reject(new Error("timeout signal did not fire")), 100);
          init.signal.addEventListener("abort", () => {
            clearTimeout(holdOpen);
            reject(init.signal.reason);
          }, { once: true });
        });
      },
    });
    await assert.rejects(
      provider.complete(completionRequest()),
      (error) => error instanceof ModelTimeoutError &&
        !error.message.includes("never-echo-this-secret"),
    );
  });

  it("keeps timeout classification while a response body is stalled", async () => {
    const provider = new OpenAICompatibleModelProvider({
      base_url: "http://127.0.0.1:11434/v1",
      model: "test-model",
      timeout_ms: 1,
      async fetch(_url, init) {
        const body = new ReadableStream({
          start(controller) {
            const holdOpen = setTimeout(
              () => controller.error(new Error("timeout signal did not fire")),
              100,
            );
            init.signal.addEventListener("abort", () => {
              clearTimeout(holdOpen);
              controller.error(init.signal.reason);
            }, { once: true });
          },
        });
        return new Response(body, { status: 200 });
      },
    });
    await assert.rejects(
      provider.complete(completionRequest()),
      (error) => error instanceof ModelTimeoutError,
    );
  });

  it("does not include upstream bodies or credentials in errors", async () => {
    const provider = new OpenAICompatibleModelProvider({
      base_url: "http://127.0.0.1:11434/v1",
      model: "test-model",
      api_key_ref: "env:MODEL_TEST_KEY",
      env: { MODEL_TEST_KEY: "never-echo-this-secret" },
      async fetch() {
        return new Response("upstream-private-body", { status: 503 });
      },
    });
    await assert.rejects(
      provider.complete(completionRequest()),
      (error) => error instanceof ModelUpstreamError &&
        error.message === "Model provider returned HTTP 503" &&
        !error.message.includes("upstream-private-body") &&
        !error.message.includes("never-echo-this-secret"),
    );
  });

  it("mounts and disposes the configured provider", async () => {
    const host = await createHost();
    const handle = await host.plugin(modelProviderPlugin, { driver: "none" });
    assert.deepEqual(await host.get("model").health(), {
      status: "degraded",
      driver: "none",
    });
    await handle.dispose();
    assert.throws(() => host.get("model"), /Service is not available/);
    await host.dispose();
  });

  it("degrades invalid plugin configuration without blocking the host", async () => {
    const host = await createHost();
    await host.plugin(modelProviderPlugin, {
      driver: "openai_compatible",
      base_url: "",
      model: "",
    });
    assert.deepEqual(await host.get("model").health(), {
      status: "degraded",
      driver: "none",
    });
    await assert.rejects(
      host.get("model").complete(completionRequest()),
      (error) => error instanceof ModelUnavailableError &&
        error.message === "Model provider configuration is invalid",
    );
    await host.dispose();
  });

  it("builds provider configuration from an explicit environment map", () => {
    assert.deepEqual(modelProviderConfigFromEnv({}), { driver: "none" });
    const env = {
      REGENIC_MODEL_DRIVER: "openai_compatible",
      REGENIC_MODEL_BASE_URL: "http://127.0.0.1:11434/v1",
      REGENIC_MODEL_NAME: "local-model",
      REGENIC_MODEL_API_KEY_REF: "env:LOCAL_MODEL_KEY",
      LOCAL_MODEL_KEY: "runtime-secret",
      UNRELATED_SECRET: "must-not-be-forwarded",
    };
    assert.deepEqual(modelProviderConfigFromEnv(env), {
      driver: "openai_compatible",
      base_url: "http://127.0.0.1:11434/v1",
      model: "local-model",
      api_key_ref: "env:LOCAL_MODEL_KEY",
      timeout_ms: 30_000,
      max_response_bytes: 1_048_576,
      env: { LOCAL_MODEL_KEY: "runtime-secret" },
    });
    assert.deepEqual(
      modelProviderConfigFromEnv({ REGENIC_MODEL_DRIVER: "unknown" }),
      {
        driver: "none",
        message: "Model provider configuration is invalid",
      },
    );
    assert.deepEqual(modelProviderConfigFromEnv({
      REGENIC_MODEL_DRIVER: "openai_compatible",
      REGENIC_MODEL_BASE_URL: "http://127.0.0.1:11434/v1",
      REGENIC_MODEL_NAME: "local-model",
      REGENIC_MODEL_TIMEOUT_MS: "not-a-number",
    }), {
      driver: "none",
      message: "Model provider configuration is invalid",
    });
  });
});
