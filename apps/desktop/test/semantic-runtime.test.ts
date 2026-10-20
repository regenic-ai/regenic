import assert from "node:assert/strict";
import { spawn, type SpawnOptions } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SemanticRuntime } from "../src/main/semantic-runtime.ts";
import { semanticAction } from "../src/shared/semantic-runtime.ts";
import { loadDesktopPreference, saveDesktopPreference, saveKernelPreference, saveLocalePreference } from "../src/main/kernel-settings.ts";
import { contextSearchInput } from "../src/renderer/src/context-search.ts";
import { en, zh, type MessageKey } from "../src/shared/messages.ts";

const revision = "914f7f89142e33e77833254d9c9b90c3cef7303b";
const descriptor = { model_id: "google/embeddinggemma-2", model_revision: revision, dimensions: 768 };

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "regenic-semantic-"));
  const assets = join(root, "assets");
  mkdirSync(assets);
  writeFileSync(join(assets, "serve.py"), "# fixture");
  writeFileSync(join(assets, "requirements.txt"), "# fixture");
  const calls: Array<{ binary: string; args: string[]; options: SpawnOptions }> = [];
  let fail = false;
  let failAt: string | undefined;
  let hold = false;
  let health = descriptor;
  let healthWait: Promise<void> | undefined;
  let server: ReturnType<typeof spawn> | undefined;
  const runtime = new SemanticRuntime({
    root, assets, startupMs: 30,
    spawn(binary, args, options) {
      calls.push({ binary, args, options });
      if (args.includes("venv")) {
        const bin = join(root, "venv", process.platform === "win32" ? "Scripts" : "bin");
        mkdirSync(bin, { recursive: true });
        writeFileSync(join(bin, process.platform === "win32" ? "python.exe" : "python"), "");
      }
      const serving = args.includes("--port");
      const child = spawn(process.execPath, ["-e", serving || hold ? "setInterval(() => {}, 1000)" : `process.exit(${fail || (failAt && args.includes(failAt)) ? 1 : 0})`], { stdio: "ignore" });
      if (serving) server = child;
      return child;
    },
    fetch: async () => {
      await healthWait;
      return new Response(JSON.stringify({ status: "ready", descriptor: health }));
    },
  });
  return { runtime, root, assets, calls, fail: () => { fail = true; }, hold: () => { hold = true; },
    wrongHealth: () => { health = { ...descriptor, dimensions: 1 }; },
    correctHealth: () => { health = descriptor; },
    failDownload: () => { failAt = "--download-only"; },
    deferHealth: () => {
      let release: () => void = () => {};
      healthWait = new Promise<void>((resolve) => { release = resolve; });
      return release;
    },
    server: () => server,
    cleanup: () => { runtime.shutdown(); rmSync(root, { recursive: true, force: true }); } };
}

test("semantic actions and search input are bounded and literal", () => {
  for (const action of ["install", "start", "stop"]) assert.equal(semanticAction(action), action);
  for (const action of [null, {}, "exec", "START"]) assert.throws(() => semanticAction(action));
  assert.deepEqual(contextSearchInput(" query ", " mail ", " literal/thread ", 20), {
    query: "query", limit: 20, filters: { sources: ["mail"], thread_ids: ["literal/thread"] },
  });

  assert.deepEqual(contextSearchInput("x", "", "", 1), { query: "x", limit: 1 });
  for (const [query, limit] of [["", 20], ["x".repeat(8001), 20], ["x", 101], ["x", 1.2]] as const) {
    assert.throws(() => contextSearchInput(query, "", "", limit), /search.invalid/);
  }
});

test("search and model messages preserve English/Chinese interpolation variables", () => {
  for (const key of Object.keys(en) as MessageKey[]) {
    if (!key.startsWith("search.") && !key.startsWith("semantic.") && key !== "nav.search") continue;
    assert.ok(zh[key].trim(), key);
    assert.deepEqual([...en[key].matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort(),
      [...zh[key].matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort(), key);
  }
});

test("semantic preference is optional and survives locale and kernel changes", () => {
  const f = fixture();
  try {
    const file = join(f.root, "preferences.json");
    assert.equal(loadDesktopPreference(file).semanticEnabled, undefined);
    saveDesktopPreference(file, { mode: "local", locale: "en", semanticEnabled: true });
    saveLocalePreference(file, "zh");
    saveKernelPreference(file, { mode: "custom", origin: "https://example.com" });
    assert.equal(loadDesktopPreference(file).semanticEnabled, true);
    saveDesktopPreference(file, { ...loadDesktopPreference(file), semanticEnabled: false });
    assert.equal(loadDesktopPreference(file).semanticEnabled, false);
  } finally { f.cleanup(); }
});

test("install uses isolated fixed assets, actual verification before marker and offline owned start", async () => {
  const f = fixture();
  try {
    assert.equal(f.runtime.view(false, true).stage, "not_installed");
    await f.runtime.install();
    assert.equal(f.runtime.view(false, true).installed, true);
    assert.equal(f.calls.length, 4);
    assert.ok(f.calls[0].args.includes("import sys; assert sys.version_info[:2] == (3, 12)"));
    assert.ok(f.calls[1].args.includes(join(f.root, "venv")));
    assert.ok(f.calls[2].args.includes(join(f.assets, "requirements.txt")));
    assert.ok(f.calls[3].args.includes("--download-only"));
    assert.equal(f.calls[3].options.env?.HF_HOME, join(f.root, "cache"));
    await f.runtime.start();
    assert.equal(f.runtime.view(true, true).stage, "running");
    assert.match(f.runtime.endpoint()!, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(f.calls[4].options.env?.HF_HUB_OFFLINE, "1");
    await f.runtime.start();
    assert.equal(f.calls.length, 5);
    await assert.rejects(f.runtime.install(), /semantic.stopFirst/);
    await f.runtime.stop();
    assert.equal(f.runtime.endpoint(), undefined);
    assert.equal(f.runtime.view(false, true).stage, "stopped");
    assert.notEqual(f.server()?.signalCode, null);
  } finally { f.cleanup(); }
});

test("failed install never advertises readiness and source changes invalidate the marker", async () => {
  const f = fixture();
  try {
    await f.runtime.install();
    writeFileSync(join(f.assets, "serve.py"), "# changed");
    assert.equal(f.runtime.view(false, true).installed, false);
    await assert.rejects(f.runtime.start(), /semantic.installFirst/);
    f.fail();
    await assert.rejects(f.runtime.install(), /semantic.pythonRequired/);
    assert.equal(f.runtime.view(false, true).healthy, false);
  } finally { f.cleanup(); }
});

test("a failed reinstall cannot leave an old success marker", async () => {
  const f = fixture();
  try {
    await f.runtime.install();
    f.failDownload();
    await assert.rejects(f.runtime.install(), /semantic.downloadFailed/);
    assert.equal(f.runtime.view(false, true).installed, false);
    await assert.rejects(f.runtime.start(), /semantic.installFirst/);
  } finally { f.cleanup(); }
});

test("corrupt installation markers remain repairable without claiming readiness", async () => {
  const f = fixture();
  try {
    await f.runtime.install();
    for (const marker of ["null", "{}", "{"]) {
      writeFileSync(join(f.root, "installed.json"), marker);
      assert.equal(f.runtime.view(false, true).installed, false);
    }
    await f.runtime.install();
    assert.equal(f.runtime.view(false, true).installed, true);
  } finally { f.cleanup(); }
});

test("health mismatch drains child, a live unhealthy child is replaced, and crashes are explicit", async () => {
  const f = fixture();
  try {
    await f.runtime.install();
    f.wrongHealth();
    await assert.rejects(f.runtime.start(), /semantic.startFailed/);
    assert.equal(f.runtime.endpoint(), undefined);
    assert.notEqual(f.server()?.signalCode, null);
    f.correctHealth();
    await f.runtime.start();
    const old = f.server();
    f.wrongHealth();
    await f.runtime.refreshHealth();
    assert.equal(f.runtime.view(true, true).error, "semantic.healthFailed");
    f.correctHealth();
    await f.runtime.start();
    assert.notEqual(old?.signalCode, null);
    const child = f.server()!;
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill();
    await exited;
    assert.equal(f.runtime.view(true, true).error, "semantic.processExited");
    assert.equal(f.runtime.endpoint(), undefined);
  } finally { f.cleanup(); }
});

test("operations serialize and shutdown drains an in-flight command without an installation marker", async () => {
  const f = fixture();
  try {
    f.hold();
    const install = f.runtime.install();
    const rejected = assert.rejects(install, /semantic.pythonRequired/);
    await assert.rejects(f.runtime.start(), /semantic.busy/);
    assert.equal(f.runtime.view(false, true).busy, true);
    f.runtime.shutdown();
    await rejected;
    assert.equal(f.runtime.view(false, true).installed, false);
    await assert.rejects(f.runtime.install(), /semantic.busy/);
  } finally { f.cleanup(); }
});

test("late health probes cannot revive stopped processes", async () => {
  const f = fixture();
  try {
    await f.runtime.install();
    await f.runtime.start();
    const release = f.deferHealth();
    const refreshing = f.runtime.refreshHealth();
    await f.runtime.stop();
    release();
    await refreshing;
    assert.equal(f.runtime.endpoint(), undefined);
    assert.equal(f.runtime.view(false, true).healthy, false);
    assert.equal(f.runtime.view(false, true).stage, "stopped");
  } finally { f.cleanup(); }
});
