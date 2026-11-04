import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { isolatedEnvironment, removeRoot, temporaryRoot } from "../lib.mjs";
import { auditSummary } from "../report.mjs";
import compatibilityEvidence from "../compatibility-evidence.cjs";

const {
  assertCandidatePackage,
  assertInstalledTarball,
  assertPackageVersion,
  assertRuntimeOverride,
  parseAuditResult,
} = compatibilityEvidence;

test("candidate tarball lookup validates the exact npm v3 top-level package entry", (t) => {
  const root = temporaryRoot("lock-entry");
  t.after(() => removeRoot(root));
  const name = "connector-contract";
  const packageDir = join(root, "node_modules/@regenic", name);
  mkdirSync(packageDir, { recursive: true });
  const manifest = join(packageDir, "package.json");
  writeFileSync(manifest, '{"version":"0.3.0"}');
  const tarball = join(root, "candidate.tgz");
  writeFileSync(tarball, "synthetic packed bytes");
  const digest = createHash("sha512").update("synthetic packed bytes").digest();
  const artifact = { path: tarball, sha512: digest.toString("hex"), version: "0.3.0" };
  const actual = { version: "0.3.0", manifest_realpath: realpathSync(manifest) };
  const entry = { version: "0.3.0", resolved: "file:candidate.tgz", integrity: `sha512-${digest.toString("base64")}` };
  const verify = (packages, info = actual) => {
    writeFileSync(join(root, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages }));
    return assertInstalledTarball(root, name, artifact, info);
  };
  assert.equal(verify({ [`node_modules/@regenic/${name}`]: entry }).lock_integrity, entry.integrity);
  assert.throws(() => verify({ [`node_modules/plugin/node_modules/@regenic/${name}`]: entry }), /lock entry/);
  assert.throws(() => verify({ [`node_modules/@regenic/${name}`]: { ...entry, integrity: "sha512-wrong" } }), /integrity/);
  writeFileSync(join(root, "registry.tgz"), "other");
  assert.throws(() => verify({ [`node_modules/@regenic/${name}`]: { ...entry, resolved: "file:registry.tgz" } }), /packed tarball/);
  assert.throws(() => verify({ [`node_modules/@regenic/${name}`]: entry }, {
    ...actual, manifest_realpath: "/registry/package.json",
  }), /outside the packed candidate/);
});

test("npm installed tarball reaches the full top-level lock and identity validation", (t) => {
  const root = realpathSync(temporaryRoot("npm-tarball"));
  t.after(() => removeRoot(root));
  const source = join(root, "package");
  const consumer = join(root, "consumer");
  mkdirSync(source);
  mkdirSync(consumer);
  writeFileSync(join(source, "package.json"), JSON.stringify({
    name: "@regenic/connector-contract", version: "0.3.0", main: "index.cjs",
  }));
  writeFileSync(join(source, "index.cjs"), "module.exports = {};");
  writeFileSync(join(consumer, "package.json"), '{"name":"offline-consumer","private":true}');
  const env = isolatedEnvironment(root);
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const pack = spawnSync(npm, ["pack", "--ignore-scripts", "--json"], { cwd: source, env, encoding: "utf8" });
  assert.equal(pack.status, 0, pack.stderr);
  const tarball = join(source, JSON.parse(pack.stdout)[0].filename);
  const install = spawnSync(npm, ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], {
    cwd: consumer, env, encoding: "utf8",
  });
  assert.equal(install.status, 0, install.stderr);
  const info = {
    version: "0.3.0",
    manifest_realpath: realpathSync(join(consumer, "node_modules/@regenic/connector-contract/package.json")),
  };
  const checked = assertInstalledTarball(consumer, "connector-contract", {
    path: tarball, version: "0.3.0", sha512: createHash("sha512").update(readFileSync(tarball)).digest("hex"),
  }, info);
  assert.ok(checked.lock_resolved.endsWith(".tgz"));
});

for (const mode of ["signal-kill", "already-exited", "failed-exit", "still-running"]) {
  test(`desktop failure cleanup exits nonzero without hanging: ${mode}`, () => {
    const helper = resolve("apps/desktop/scripts/smoke-process.cjs");
    const result = spawnSync(process.execPath, ["-e", `
      const { spawn } = require("node:child_process");
      const { observeChild, runWithFailureCleanup } = require(${JSON.stringify(helper)});
      let owned;
      void runWithFailureCleanup(async () => {
        const mode = ${JSON.stringify(mode)};
        const child = spawn(process.execPath, ["-e",
          ["signal-kill", "still-running"].includes(mode) ? "setInterval(() => {}, 1000)" :
          mode === "failed-exit" ? "process.exit(7)" : "process.exit(0)"]);
        owned = observeChild(child);
        await new Promise(resolve => child.once("spawn", resolve));
        if (mode === "signal-kill") child.kill("SIGKILL");
        const result = mode === "still-running" ? {} : await owned.exited;
        if (mode === "signal-kill" && result.signal !== "SIGKILL") throw new Error("wrong signal");
        throw new Error("synthetic clean-exit failure");
      }, async () => { await owned.stop(1000); });
    `], { encoding: "utf8", timeout: 5000 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, JSON.stringify(result));
    assert.match(result.stderr, /synthetic clean-exit failure/);
  });
}

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
