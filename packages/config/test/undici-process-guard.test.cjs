const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { describe, it } = require("node:test");
const { isUndiciSocketIdleTimeout } = require("../dist/undici-process-guard");

describe("isUndiciSocketIdleTimeout", () => {
  it("matches only the informational idle timeout", () => {
    const timeout = new Error("socket idle timeout");
    timeout.code = "UND_ERR_INFO";
    assert.equal(isUndiciSocketIdleTimeout(timeout), true);
    assert.equal(isUndiciSocketIdleTimeout(new Error("socket idle timeout")), false);
    const other = new Error("boom");
    other.code = "UND_ERR_INFO";
    assert.equal(isUndiciSocketIdleTimeout(other), false);
    assert.equal(isUndiciSocketIdleTimeout(null), false);
  });
});

describe("installUndiciProcessGuard", () => {
  it("forces the built-in fetch dispatcher off HTTP/2 and keeps the process up", () => {
    const result = runGuard(`
      const originalDefine = Object.defineProperty;
      installUndiciProcessGuard();
      fetch("http://127.0.0.1:9/", { signal: AbortSignal.timeout(500) }).catch(() => {}).then(() => {
        if (Object.defineProperty !== originalDefine) {
          console.error("defineProperty hook leaked");
          process.exit(3);
        }
        const options = dispatcherOptions();
        const undiciMajor = Number(String(process.versions.undici || "0").split(".")[0]);
        if (undiciMajor >= 8 && (!options || options.allowH2 !== false)) {
          console.error("allowH2", options && options.allowH2, "undici", process.versions.undici);
          process.exit(2);
        }
        const { EventEmitter } = require("node:events");
        setTimeout(() => {
          const timeout = new Error("socket idle timeout");
          timeout.code = "UND_ERR_INFO";
          new EventEmitter().emit("error", timeout);
        }, 20);
        setTimeout(() => process.exit(0), 150);
      });
    `, { install: false });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stderr, /ignored undici http2 idle timeout/);
  });

  it("still exits on an unrelated uncaught error", () => {
    const result = runGuard(`
      setTimeout(() => new (require("node:events").EventEmitter)().emit("error", new Error("boom")), 20);
      setTimeout(() => process.exit(0), 500);
    `);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /boom/);
    assert.doesNotMatch(result.stderr, /ignored undici http2 idle timeout/);
  });
});

function runGuard(body, options = {}) {
  const config = require.resolve("../dist/undici-process-guard.js");
  const script = `
    const { installUndiciProcessGuard } = require(${JSON.stringify(config)});
    function dispatcherOptions() {
      for (const version of [2, 1]) {
        const agent = globalThis[Symbol.for("undici.globalDispatcher." + version)];
        const options = agent && Object.getOwnPropertySymbols(agent)
          .map((symbol) => agent[symbol])
          .find((value) => value && Object.prototype.hasOwnProperty.call(value, "maxOrigins"));
        if (options) return options;
      }
      return undefined;
    }
    ${options.install === false ? "" : "installUndiciProcessGuard();"}
    ${body}
  `;
  return spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    timeout: 5_000,
  });
}
