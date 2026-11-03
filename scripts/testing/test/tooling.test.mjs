import assert from "node:assert/strict";
import { test } from "node:test";
import { isolatedEnvironment, removeRoot, temporaryRoot } from "../lib.mjs";
import { auditSummary } from "../report.mjs";

test("isolated children never inherit account tokens, plugin paths or model endpoints", () => {
  const root = temporaryRoot("environment");
  const before = { ...process.env };
  try {
    Object.assign(process.env, {
      GITHUB_TOKEN: "synthetic", REGENIC_CHANNEL_PLUGIN: "/untrusted",
      REGENIC_EMBEDDING_BASE_URL: "https://not-called.invalid", NODE_OPTIONS: "--require=/not-loaded",
    });
    const env = isolatedEnvironment(root);
    for (const key of ["GITHUB_TOKEN", "REGENIC_CHANNEL_PLUGIN", "REGENIC_EMBEDDING_BASE_URL", "NODE_OPTIONS"]) {
      assert.equal(env[key], undefined);
    }
    assert.ok(env.HOME.startsWith(root));
    assert.ok(env.REGENIC_PLUGIN_DIR.startsWith(root));
  } finally {
    process.env = before;
    removeRoot(root);
  }
});

test("audit findings remain visible, while missing/invalid audit evidence fails", () => {
  const report = { metadata: { vulnerabilities: { high: 1 } }, advisories: {
    synthetic: { github_advisory_id: "GHSA-synthetic", module_name: "example", severity: "high" },
  } };
  const summary = auditSummary({ status: 1, stdout: JSON.stringify(report) });
  assert.equal(summary.vulnerabilities.high, 1);
  assert.equal(summary.advisories[0].id, "GHSA-synthetic");
  for (const result of [
    { status: 1, stdout: "{}" }, { status: 1, stdout: '{"error":"network"}' },
    { status: null, signal: "SIGTERM" }, { status: 2 },
  ]) assert.throws(() => auditSummary(result));
});
