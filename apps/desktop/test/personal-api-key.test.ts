import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import {
  PERSONAL_API_KEY_HEADER,
  isNumericLoopbackOrigin,
  personalApiRequestHeaders,
} from "../src/main/personal-api-key.ts";
import { parseKernelOrigin, savePersonalApiKey, loadSavedPersonalApiKey } from "../src/main/kernel-settings.ts";

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

  it("accepts http(s) kernel origins without credentials, including remote hosts", () => {
    assert.equal(parseKernelOrigin("http://127.0.0.1:4370/path"), "http://127.0.0.1:4370");
    assert.equal(parseKernelOrigin("https://[::1]:4370/path"), "https://[::1]:4370");
    assert.equal(parseKernelOrigin("http://localhost:4370"), "http://localhost:4370");
    assert.equal(
      parseKernelOrigin("https://ospwgguxdbkb.sealosbja.site/v1/me"),
      "https://ospwgguxdbkb.sealosbja.site",
    );
    for (const value of [
      "ftp://127.0.0.1:4370",
      "http://user@127.0.0.1:4370",
      "https://user:pass@example.com",
      "not-a-url",
    ]) {
      assert.throws(() => parseKernelOrigin(value), /http\(s\) URL/);
    }
    for (const value of [
      "http://localhost:4370",
      "https://example.com",
      "http://10.0.0.1:4370",
      "http://[fd00::1]:4370",
      "http://user@127.0.0.1:4370",
    ]) {
      assert.equal(isNumericLoopbackOrigin(value), false);
    }
  });

  it("injects the key into a configured remote kernel, but not a different origin", () => {
    assert.deepEqual(personalApiRequestHeaders({
      requestUrl: "https://example.com/v1/me/inbox",
      apiOrigin: "https://example.com",
      key: "shared-remote-key",
      headers: {},
    }), { [PERSONAL_API_KEY_HEADER]: "shared-remote-key" });
    assert.deepEqual(personalApiRequestHeaders({
      requestUrl: "https://evil.example/v1/me/inbox",
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

  it("remembers a personal API key per custom origin", () => {
    const dir = mkdtempSync(join(tmpdir(), "regenic-settings-"));
    const file = join(dir, "desktop-settings.json");
    try {
      savePersonalApiKey(file, "https://example.com", "paired-key");
      assert.equal(
        loadSavedPersonalApiKey(file, "https://example.com"),
        "paired-key",
      );
      assert.equal(loadSavedPersonalApiKey(file, "https://other.example"), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
