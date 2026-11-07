import assert from "node:assert/strict";
import { spawn, type SpawnOptions } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { embeddingLaunchPlan, type EmbeddingHardware } from "../src/main/embedding-launch.ts";
import { SemanticRuntime } from "../src/main/semantic-runtime.ts";
import {
  DEFAULT_SEMANTIC_LAUNCH_SETTINGS,
  semanticAction,
  semanticLaunchSettings,
  semanticVisualPreference,
} from "../src/shared/semantic-runtime.ts";
import { loadDesktopPreference, saveDesktopPreference, saveKernelPreference, saveLocalePreference } from "../src/main/kernel-settings.ts";
import {
  SEARCH_CONTEXT,
  SEARCH_WINDOW_PAGE,
  applySearchWindow,
  contextSearchInput,
  mergeSearchMessages,
  searchAnswerConversations,
  searchAnswerSegments,
  searchElapsedSeconds,
  searchFileType,
  searchHighlightRanges,
  searchMentionsFiles,
  searchMessageText,
  searchSnippetPreview,
  searchWindowRequest,
} from "../src/renderer/src/context-search.ts";
import { en, zh, type MessageKey } from "../src/shared/messages.ts";

const revision = "914f7f89142e33e77833254d9c9b90c3cef7303b";
const descriptor = { model_id: "google/embeddinggemma-2", model_revision: revision, dimensions: 768 };

function fixture(
  hardware: EmbeddingHardware = { cpus: 8, totalMemoryBytes: 8 * 1024 ** 3 },
  visualEnabled = false,
  launchSettings = DEFAULT_SEMANTIC_LAUNCH_SETTINGS,
  cudaAvailable = false,
) {
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
  let execution: Record<string, unknown> = { device: "cpu", precision: "bfloat16", threads: 2, visual_enabled: visualEnabled };
  let healthWait: Promise<void> | undefined;
  let server: ReturnType<typeof spawn> | undefined;
  const runtime = new SemanticRuntime({
    root, assets, startupMs: 30,
    hardware: () => hardware,
    visualEnabled: () => visualEnabled,
    launchSettings: () => launchSettings,
    cudaProbe: async () => ({ available: cudaAvailable, ...(cudaAvailable ? { deviceName: "NVIDIA Test GPU" } : {}) }),
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
      return new Response(JSON.stringify({ status: "ready", descriptor: health, runtime: execution }));
    },
  });
  return { runtime, root, assets, calls, fail: () => { fail = true; }, hold: () => { hold = true; },
    launchSettings: (value: typeof launchSettings) => { launchSettings = value; },
    wrongHealth: () => { health = { ...descriptor, dimensions: 1 }; },
    correctHealth: () => { health = descriptor; },
    execution: (value: Record<string, unknown>) => { execution = { visual_enabled: visualEnabled, ...value }; },
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
  assert.deepEqual(semanticLaunchSettings(DEFAULT_SEMANTIC_LAUNCH_SETTINGS), DEFAULT_SEMANTIC_LAUNCH_SETTINGS);
  assert.throws(() => semanticLaunchSettings({ ...DEFAULT_SEMANTIC_LAUNCH_SETTINGS, threads: 0 }, 8));
  assert.throws(() => semanticLaunchSettings({ ...DEFAULT_SEMANTIC_LAUNCH_SETTINGS, threads: 9 }, 8));
  assert.throws(() => semanticLaunchSettings({ ...DEFAULT_SEMANTIC_LAUNCH_SETTINGS, device: "mps" }, 8, false));
  assert.throws(() => semanticLaunchSettings({ ...DEFAULT_SEMANTIC_LAUNCH_SETTINGS, device: "cuda" }, 8, true));
  assert.equal(semanticLaunchSettings({ ...DEFAULT_SEMANTIC_LAUNCH_SETTINGS, device: "cuda" }, 8, true, true).device, "cuda");
  assert.deepEqual(contextSearchInput(" query ", " mail ", " literal/thread ", 20), {
    query: "query", limit: 20, kind: "all", filters: { sources: ["mail"], thread_ids: ["literal/thread"] },
    context: SEARCH_CONTEXT,
  });

  assert.deepEqual(contextSearchInput("x", "", "", 1), { query: "x", limit: 1, kind: "all", context: SEARCH_CONTEXT });
  for (const kind of ["all", "messages", "files"] as const) {
    assert.equal(contextSearchInput("budget.xlsx", "", "", 10, kind).kind, kind);
  }
  for (const [query, limit] of [["", 20], ["x".repeat(8001), 20], ["x", 21], ["x", 1.2]] as const) {
    assert.throws(() => contextSearchInput(query, "", "", limit), /search.invalid/);
  }
  assert.ok(contextSearchInput("x", "", "", 20).limit <= SEARCH_CONTEXT.max_messages);
});

test("search highlighting finds Chinese runs without whitespace and Latin terms case-insensitively", () => {
  const query = "上次选中的 2 位都还没回复吗？";
  assert.deepEqual(searchHighlightRanges("上次选中的 2 位都还没回复吗？", query), [[0, 5], [8, 15]]);
  assert.deepEqual(searchHighlightRanges("上次确认小王和小李，共 2 位。", query), [[0, 2]]);
  assert.deepEqual(searchHighlightRanges("这里的回复指邀约回复。", query), [[3, 5], [8, 10]]);
  assert.deepEqual(searchHighlightRanges("Alice is Creator-1", "creator alice"), [[0, 5], [9, 16]]);
  assert.deepEqual(searchHighlightRanges("无关内容", query), []);
});

test("search highlighting keeps Latin words whole next to CJK text", () => {
  const query = "看下最近有哪些Excel文件";
  assert.deepEqual(searchHighlightRanges("device Space excellent", query), []);
  assert.deepEqual(searchHighlightRanges("Budget.xlsx is an Excel workbook", query), [[18, 23]]);
  assert.deepEqual(searchHighlightRanges("这些Excel文件", query), [[2, 9]]);
});

test("search file types prefer specific metadata and fall back to the filename", () => {
  assert.deepEqual(searchFileType("index.html", "application/octet-stream"),
    { format: "HTML", badge: "HTML", category: "code", code: true });
  assert.equal(searchFileType("notes.md", "application/octet-stream").format, "Markdown");
  assert.equal(searchFileType("report.bin", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").format, "Excel");
  assert.equal(searchFileType("photo", "image/jpeg").format, "JPEG");
  assert.equal(searchFileType("data.custom", "application/x-custom").format, "application/x-custom");
  assert.deepEqual(searchFileType("blob", "application/octet-stream"),
    { format: null, badge: "", category: "file", code: false });
  assert.equal(searchFileType(undefined, undefined).format, null);
});

test("search snippet previews flag long excerpts and file intent is only detected", () => {
  assert.deepEqual(searchSnippetPreview("\n\nshort\ntext  "), { text: "short\ntext", long: false });
  assert.equal(searchSnippetPreview(Array.from({ length: 7 }, (_, i) => `line ${i}`).join("\n")).long, true);
  assert.equal(searchSnippetPreview("x".repeat(361)).long, true);
  assert.equal(searchMentionsFiles("看下最近有哪些Excel文件"), true);
  assert.equal(searchMentionsFiles("send the xlsx"), true);
  assert.equal(searchMentionsFiles("profile update"), false);
  assert.equal(searchElapsedSeconds(583), "0.58");
  assert.equal(searchElapsedSeconds(12_345), "12.3");
});

test("search cards load windows from their boundaries and close them when exhausted", () => {
  const message = (id: string, minute: number) => ({ event_id: id, occurred_at: `2026-10-20T00:0${minute}:00.000Z` });
  const card = {
    thread_id: "t",
    read_epoch: "epoch-1",
    messages: [message("c", 3), message("f", 6)],
    continuation: {
      before: { event_id: "c", occurred_at: message("c", 3).occurred_at },
      after: { event_id: "f", occurred_at: message("f", 6).occurred_at },
      gaps: [{ after: { event_id: "c", occurred_at: message("c", 3).occurred_at }, before: { event_id: "f", occurred_at: message("f", 6).occurred_at } }],
    },
  };
  assert.deepEqual(searchWindowRequest(card, { kind: "gap", index: 0 }), {
    thread_id: "t", read_epoch: "epoch-1", limit: SEARCH_WINDOW_PAGE, direction: "after",
    boundary: card.continuation.gaps[0].after, until: card.continuation.gaps[0].before,
  });

  const earlier = applySearchWindow(card, { kind: "before" }, { messages: [message("b", 2)], has_more: true });
  assert.deepEqual(earlier.messages.map((entry) => entry.event_id), ["b", "c", "f"]);
  assert.deepEqual(earlier.continuation.before, { event_id: "b", occurred_at: message("b", 2).occurred_at });

  const partGap = applySearchWindow(earlier, { kind: "gap", index: 0 }, { messages: [message("d", 4)], has_more: true });
  assert.deepEqual(partGap.continuation.gaps, [{
    after: { event_id: "d", occurred_at: message("d", 4).occurred_at }, before: card.continuation.gaps[0].before,
  }]);
  const closedGap = applySearchWindow(partGap, { kind: "gap", index: 0 }, { messages: [message("e", 5)], has_more: false });
  assert.deepEqual(closedGap.messages.map((entry) => entry.event_id), ["b", "c", "d", "e", "f"]);
  assert.deepEqual(closedGap.continuation.gaps, []);

  const end = applySearchWindow(closedGap, { kind: "after" }, { messages: [], has_more: false });
  assert.equal(end.continuation.after, null);
  assert.equal(searchWindowRequest(end, { kind: "after" }), undefined);
  assert.deepEqual(mergeSearchMessages([message("b", 2)], [message("b", 2), message("a", 1)]).map((entry) => entry.event_id), ["a", "b"]);
});

test("search answers send visible cards and turn resolved [n] markers into citations", () => {
  const many = Array.from({ length: 150 }, (_, index) => ({ event_id: `e${index}` }));
  const selected = searchAnswerConversations([
    { thread_id: "a", messages: many },
    { thread_id: "b", messages: many },
    { thread_id: "c", messages: many },
  ]);
  assert.deepEqual(selected.map((entry) => [entry.thread_id, entry.event_ids.length]), [["a", 150], ["b", 50]]);

  assert.deepEqual(searchAnswerSegments("Alice [1], Bob [3]. [9] [x]", [
    { ref: 1, event_id: "e1" },
    { ref: 3, event_id: "e3" },
  ]), [
    { text: "Alice " },
    { ref: 1, event_id: "e1" },
    { text: ", Bob " },
    { ref: 3, event_id: "e3" },
    { text: ". [9] [x]" },
  ]);
});

test("search cards render attachment-only messages as placeholders", () => {
  const labels = { image: "[图片]", file: (name: string) => `[文件 ${name}]` };
  assert.equal(searchMessageText({ text: "", attachments: [{ media_type: "image/png" }] }, labels), "[图片]");
  assert.equal(
    searchMessageText({ text: "看下这个", attachments: [{ media_type: "application/pdf", filename: "brief.pdf" }] }, labels),
    "看下这个 [文件 brief.pdf]",
  );
  assert.equal(searchMessageText({ text: "纯文本" }, labels), "纯文本");
});

test("search and model messages preserve English/Chinese interpolation variables", () => {
  for (const key of Object.keys(en) as MessageKey[]) {
    if (!key.startsWith("search.") && !key.startsWith("semantic.") && key !== "nav.search") continue;
    assert.ok(zh[key].trim(), key);
    assert.deepEqual([...en[key].matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort(),
      [...zh[key].matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort(), key);
  }
});

test("embedding launch reserves cores on small machines and widens large ones", () => {
  const gib = 1024 ** 3;
  assert.deepEqual(embeddingLaunchPlan({ cpus: 8, totalMemoryBytes: 8 * gib }), {
    device: "cpu", precision: "bfloat16", threads: 2, nice: 5,
  });
  assert.deepEqual(embeddingLaunchPlan({ cpus: 10, totalMemoryBytes: 16 * gib }), {
    device: "cpu", precision: "float32", threads: 8, nice: 0,
  });
  assert.deepEqual(embeddingLaunchPlan({ cpus: 2, totalMemoryBytes: 16 * gib }), {
    device: "cpu", precision: "float32", threads: 1, nice: 0,
  });
  assert.deepEqual(embeddingLaunchPlan({ cpus: Number.NaN, totalMemoryBytes: Number.NaN }), {
    device: "cpu", precision: "bfloat16", threads: 1, nice: 5,
  });
});

test("Apple Silicon verifies acceleration and Mac CPU work leaves room for interactive apps", () => {
  const hardware = { cpus: 15, totalMemoryBytes: 24 * 1024 ** 3, platform: "darwin" as const, arch: "arm64" };
  assert.deepEqual(embeddingLaunchPlan(hardware), { device: "auto-mps", precision: "float32", threads: 7, nice: 5 });
  assert.deepEqual(embeddingLaunchPlan({ ...hardware, cpus: 32 }).threads, 8);
  assert.equal(embeddingLaunchPlan({ ...hardware, totalMemoryBytes: 8 * 1024 ** 3 }).device, "cpu");
  assert.equal(embeddingLaunchPlan({ ...hardware, arch: "x64" }).device, "cpu");
  assert.equal(embeddingLaunchPlan({ ...hardware, platform: "linux" }).device, "cpu");
  assert.equal(embeddingLaunchPlan({ ...hardware, cpus: 1 }).threads, 1);
  assert.equal(embeddingLaunchPlan({ ...hardware, totalMemoryBytes: 12 * 1024 ** 3 }).device, "auto-mps");
  assert.deepEqual(embeddingLaunchPlan(hardware, {
    device: "mps", precision: "bfloat16", threads: 3, priority: "normal",
  }), { device: "mps", precision: "bfloat16", threads: 3, nice: 0 });
  assert.equal(embeddingLaunchPlan({ ...hardware, platform: "linux" }, undefined, true).device, "auto-cuda");
  assert.equal(embeddingLaunchPlan({ ...hardware, platform: "win32" }, undefined, true).device, "auto-cuda");
  assert.deepEqual(embeddingLaunchPlan({ ...hardware, platform: "linux" }, {
    device: "cuda", precision: "float32", threads: 4, priority: "normal",
  }, true), { device: "cuda", precision: "float32", threads: 4, nice: 0 });
});

test("runtime recommends detected CUDA and launches explicit NVIDIA GPU selection", async () => {
  const settings = { device: "cuda", precision: "bfloat16", threads: 4, priority: "normal" } as const;
  const f = fixture({ cpus: 16, totalMemoryBytes: 32 * 1024 ** 3, platform: "linux", arch: "x64" },
    false, settings, true);
  try {
    await f.runtime.install();
    const view = f.runtime.view(false, true);
    assert.equal(view.canUseCuda, true);
    assert.equal(view.cudaDeviceName, "NVIDIA Test GPU");
    assert.equal(view.recommendedSettings?.device, "auto-cuda");
    assert.deepEqual(view.detectedHardware, {
      platform: "linux", arch: "x64", cpus: 16, totalMemoryBytes: 32 * 1024 ** 3,
    });
    f.execution({ device: "cuda", precision: "bfloat16", threads: 4 });
    await f.runtime.start();
    const serving = f.calls.find((call) => call.args.includes("--port"));
    assert.ok(serving);
    assert.deepEqual(serving.args.slice(-4), ["--device", "cuda", "--precision", "bfloat16"]);
  } finally { f.cleanup(); }
});

test("runtime uses user-selected device, precision, threads and scheduling priority at install and start", async () => {
  const settings = { device: "mps", precision: "bfloat16", threads: 3, priority: "normal" } as const;
  const f = fixture({ cpus: 15, totalMemoryBytes: 24 * 1024 ** 3, platform: "darwin", arch: "arm64" }, false, settings);
  try {
    await f.runtime.install();
    const download = f.calls.find((call) => call.args.includes("--download-only"));
    assert.ok(download);
    assert.deepEqual(download.args.slice(-4), ["--device", "cpu", "--precision", "bfloat16"]);
    assert.equal(download.options.env?.OMP_NUM_THREADS, "3");
    f.execution({ device: "mps", precision: "bfloat16", threads: 3 });
    await f.runtime.start();
    const serving = f.calls.find((call) => call.args.includes("--port"));
    assert.ok(serving);
    assert.deepEqual(serving.args.slice(-4), ["--device", "mps", "--precision", "bfloat16"]);
    assert.equal(serving.options.env?.OMP_NUM_THREADS, "3");
    assert.deepEqual(embeddingLaunchPlan(
      { cpus: 15, totalMemoryBytes: 24 * 1024 ** 3, platform: "darwin", arch: "arm64" }, settings,
    ), { device: "mps", precision: "bfloat16", threads: 3, nice: 0 });
  } finally { f.cleanup(); }
});

test("runtime reports verified backend and CPU fallback, never just the requested device", async () => {
  const f = fixture({ cpus: 15, totalMemoryBytes: 24 * 1024 ** 3, platform: "darwin", arch: "arm64" });
  try {
    await f.runtime.install();
    assert.equal(f.runtime.view(false, true).execution, undefined);
    f.execution({ device: "mps", precision: "float32", threads: 7 });
    await f.runtime.start();
    assert.deepEqual(f.calls[4].args.slice(-4), ["--device", "auto-mps", "--precision", "float32"]);
    assert.equal(f.calls[4].options.env?.VECLIB_MAXIMUM_THREADS, "7");
    assert.deepEqual(f.runtime.view(true, true).execution, { device: "mps", precision: "float32", threads: 7 });
    await f.runtime.stop();
    assert.equal(f.runtime.view(false, true).execution, undefined);
    for (const reason of ["mps_failed", "mps_unavailable"] as const) {
      f.execution({ device: "cpu", precision: "float32", threads: 7, fallback_reason: reason });
      await f.runtime.start();
      assert.deepEqual(f.runtime.view(true, true).execution, {
        device: "cpu", precision: "float32", threads: 7, fallbackReason: reason,
      });
      await f.runtime.stop();
    }
  } finally { f.cleanup(); }
});

test("invalid execution diagnostics cannot advertise healthy model readiness", async () => {
  const f = fixture();
  try {
    await f.runtime.install();
    for (const execution of [
      {}, { device: "cuda", precision: "float32", threads: 2 },
      { device: "cpu", precision: "float16", threads: 2 },
      { device: "cpu", precision: "float32", threads: 0 },
      { device: "cpu", precision: "float32", threads: 1.5 },
      { device: "mps", precision: "float32", threads: 2, fallback_reason: "mps_failed" },
      { device: "cpu", precision: "float32", threads: 2, fallback_reason: "unknown" },
    ]) {
      f.execution(execution);
      await assert.rejects(f.runtime.start(), /semantic.startFailed/);
      assert.equal(f.runtime.view(true, true).execution, undefined);
      assert.equal(f.runtime.endpoint(), undefined);
    }
  } finally { f.cleanup(); }
});

test("visual encoder loads only with explicit opt-in and readiness must match the permission", async () => {
  const f = fixture(undefined, true);
  try {
    await f.runtime.install();
    assert.ok(f.calls[3].args.includes("--visual"));
    await f.runtime.start();
    assert.ok(f.calls[4].args.includes("--visual"));
    await f.runtime.stop();
    f.execution({ device: "cpu", precision: "bfloat16", threads: 2, visual_enabled: false });
    await assert.rejects(f.runtime.start(), /semantic.startFailed/);
  } finally { f.cleanup(); }
});

test("semantic preference is optional and survives locale and kernel changes", () => {
  const f = fixture();
  try {
    const file = join(f.root, "preferences.json");
    assert.equal(loadDesktopPreference(file).semanticEnabled, undefined);
    assert.deepEqual(loadDesktopPreference(file).semanticLaunchSettings, DEFAULT_SEMANTIC_LAUNCH_SETTINGS);
    assert.equal(semanticVisualPreference(false), false);
    assert.equal(semanticVisualPreference(true), true);
    for (const value of [undefined, null, "true", 1, {}]) assert.throws(() => semanticVisualPreference(value));
    assert.equal(loadDesktopPreference(file).semanticVisualEnabled, undefined);
    const customSettings = { device: "cpu", precision: "float32", threads: 4, priority: "background" } as const;
    saveDesktopPreference(file, {
      mode: "local", locale: "en", semanticEnabled: true, semanticVisualEnabled: true,
      semanticLaunchSettings: customSettings,
    });
    saveLocalePreference(file, "zh");
    saveKernelPreference(file, { mode: "custom", origin: "https://example.com" });
    assert.equal(loadDesktopPreference(file).semanticEnabled, true);
    assert.equal(loadDesktopPreference(file).semanticVisualEnabled, true);
    assert.deepEqual(loadDesktopPreference(file).semanticLaunchSettings, customSettings);
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
    assert.deepEqual(f.calls[3].args.slice(-4), ["--device", "cpu", "--precision", "bfloat16"]);
    assert.equal(f.calls[3].options.env?.HF_HOME, join(f.root, "cache"));
    assert.equal(f.calls[3].options.env?.OMP_NUM_THREADS, "2");
    assert.equal(f.calls[3].options.env?.VECLIB_MAXIMUM_THREADS, "2");
    assert.equal(f.calls[3].options.env?.OMP_WAIT_POLICY, "PASSIVE");
    await f.runtime.start();
    assert.equal(f.runtime.view(true, true).stage, "running");
    assert.match(f.runtime.endpoint()!, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.ok(f.calls[4].args.includes("--precision"));
    assert.ok(f.calls[4].args.includes("bfloat16"));
    assert.equal(f.calls[4].options.env?.HF_HUB_OFFLINE, "1");
    assert.equal(f.calls[4].args.includes("--visual"), false);
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
    assert.equal(f.runtime.view(false, true).execution, undefined);
  } finally { f.cleanup(); }
});
