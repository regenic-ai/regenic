import assert from "node:assert/strict";
import { test } from "node:test";
import { isolatedEnvironment, removeRoot, temporaryRoot } from "../lib.mjs";
import { auditSummary } from "../report.mjs";
import compatibilityEvidence from "../compatibility-evidence.cjs";

const {
  assertCandidatePackage,
  assertPackageVersion,
  assertRuntimeOverride,
  parseAuditResult,
} = compatibilityEvidence;

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

test("candidate package identity rejects a registry package with the same version", () => {
  const candidate = {
    manifest_realpath: "/tmp/packed-sdk/node_modules/@regenic/connector-contract/package.json",
    version: "0.3.0",
  };
  const registry = {
    manifest_realpath: "/tmp/source/node_modules/@regenic/connector-contract/package.json",
    version: "0.3.0",
  };
  assert.throws(
    () => assertCandidatePackage(registry, candidate, "0.3.0"),
    /resolved outside the packed candidate/,
  );
  assert.doesNotThrow(() => assertCandidatePackage(candidate, candidate, "0.3.0"));
});

test("runtime override evidence rejects a manifest-only Zod pin", () => {
  assert.throws(
    () => assertRuntimeOverride("4.6.7", { version: "3.25.0" }, "4.6.7", "Copilot SDK Zod"),
    /expected 4\.6\.7, got 3\.25\.0/,
  );
  assert.throws(
    () => assertRuntimeOverride(undefined, { version: "4.6.7" }, "4.6.7", "Copilot SDK Zod"),
    /manifest override does not declare 4\.6\.7/,
  );
  assert.throws(
    () => assertPackageVersion({ version: "3.25.0" }, "4.6.7", "Copilot SDK Zod"),
    /expected 4\.6\.7, got 3\.25\.0/,
  );
  assert.doesNotThrow(() =>
    assertPackageVersion({ version: "4.6.7" }, "4.6.7", "Copilot SDK Zod"),
  );
});

test("audit subprocess and full pretty-printed JSON output are validated", () => {
  const report = { metadata: { vulnerabilities: { high: 1 } }, advisories: {} };
  assert.deepEqual(parseAuditResult({
    status: 1,
    stdout: JSON.stringify(report, null, 2),
  }), report);
  assert.throws(
    () => parseAuditResult({ status: null, error: new Error("spawn failed"), stdout: "" }),
    /could not complete: spawn failed/,
  );
  assert.throws(() => parseAuditResult({ status: 0, stdout: "WARN\n{}" }), /invalid JSON/);
  assert.throws(
    () => parseAuditResult({ status: 1, stdout: JSON.stringify(report), stderr: "ERR_PNPM_AUDIT_FETCH" }),
    /transport or registry error/,
  );
});
