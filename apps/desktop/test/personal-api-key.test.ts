import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PERSONAL_API_KEY_HEADER,
  isNumericLoopbackOrigin,
  personalApiRequestHeaders,
} from "../src/main/personal-api-key.ts";
import { parseKernelOrigin } from "../src/main/kernel-settings.ts";

describe("personal API key injection", () => {
  it("adds the ephemeral key only to the current Personal API", () => {
    const original = { accept: "application/json" };
    const headers = personalApiRequestHeaders({
      requestUrl: "http://127.0.0.1:4370/v1/me/context/ask",
      apiOrigin: "http://127.0.0.1:4370",
      key: "ephemeral-test-key",
      headers: original,
    });

    assert.deepEqual(headers, {
      accept: "application/json",
      [PERSONAL_API_KEY_HEADER]: "ephemeral-test-key",
    });
    assert.deepEqual(original, { accept: "application/json" });
  });

  it("does not add the key to health, another origin, or an invalid URL", () => {
    for (const requestUrl of [
      "http://127.0.0.1:4370/health",
      "http://127.0.0.1:4371/v1/me/inbox",
      "https://example.com/v1/me/inbox",
      "not-a-url",
    ]) {
      assert.deepEqual(personalApiRequestHeaders({
        requestUrl,
        apiOrigin: "http://127.0.0.1:4370",
        key: "ephemeral-test-key",
        headers: {},
      }), {});
    }
  });

  it("accepts only numeric loopback kernel origins", () => {
    assert.equal(parseKernelOrigin("http://127.0.0.1:4370/path"), "http://127.0.0.1:4370");
    assert.equal(parseKernelOrigin("https://[::1]:4370/path"), "https://[::1]:4370");
    for (const value of [
      "http://localhost:4370",
      "https://example.com",
      "http://10.0.0.1:4370",
      "http://[fd00::1]:4370",
      "http://user@127.0.0.1:4370",
    ]) {
      assert.equal(isNumericLoopbackOrigin(value), false);
      assert.throws(() => parseKernelOrigin(value), /numeric loopback/);
    }
  });

  it("never injects a key into a remote API origin", () => {
    assert.deepEqual(personalApiRequestHeaders({
      requestUrl: "https://example.com/v1/me/inbox",
      apiOrigin: "https://example.com",
      key: "must-not-leak",
      headers: {},
    }), {});
  });

  it("does not add a missing key", () => {
    assert.deepEqual(personalApiRequestHeaders({
      requestUrl: "http://127.0.0.1:4370/v1/me/inbox",
      apiOrigin: "http://127.0.0.1:4370",
      key: null,
      headers: { accept: "application/json" },
    }), { accept: "application/json" });
  });
});
