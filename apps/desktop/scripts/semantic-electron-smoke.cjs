const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { existsSync, mkdtempSync, mkdirSync, rmSync } = require("node:fs");
const { createServer } = require("node:http");
const { createRequire } = require("node:module");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const desktop = resolve(__dirname, "..");
const repo = resolve(desktop, "../..");
const apiRequire = createRequire(join(repo, "apps", "api", "package.json"));
const { SqliteAuthorityStore } = apiRequire("@regenic/authority-store/sqlite");
const { IngestionService } = apiRequire("@regenic/domain");
const { FsBlobStore } = apiRequire("@regenic/blob-store");
const { EMBEDDINGGEMMA_2 } = apiRequire("@regenic/embedding-provider");
const root = mkdtempSync(join(tmpdir(), "regenic-semantic-electron-"));
const profile = join(root, "profile");
const data = join(root, "data");
const database = join(data, "authority.db");
const blobRoot = join(data, "blobs");
mkdirSync(data);

async function waitFor(check, label, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
}

async function ingest(operation, text) {
  const authority = new SqliteAuthorityStore(database);
  try {
    const result = await new IngestionService(new FsBlobStore(blobRoot), authority).ingest({
      schema_version: "1.0", connector_id: "synthetic", org_id: "smoke-owner",
      delivery_id: operation, received_at: new Date().toISOString(),
      records: [{
        operation, source: "synthetic", external_id: "conversation:message",
        occurred_at: new Date().toISOString(), actor: { id: "person" }, scope: { id: "conversation" },
        type: "message", content: [{ role: "body", media_type: "text/plain", text }],
      }],
    });
    assert.equal(result.records?.[0].status, "accepted", JSON.stringify(result));
    return result.records[0].event_id;
  } finally { authority.close(); }
}

async function main() {
  assert.equal(typeof WebSocket, "function", "Use Node.js 22 or newer");
  assert.ok(existsSync(join(desktop, "out", "main", "index.js")), "Build the API and desktop first");
  const eventId = await ingest("create", "RG-SMOKE original source <img src=x onerror=alert(1)>");
  let broken = true;
  const model = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.setHeader("content-type", "application/json");
    if (broken && request.url === "/embed") {
      response.writeHead(409);
      response.end(JSON.stringify({ error: "synthetic mismatch" }));
    } else response.end(JSON.stringify({
      descriptor: EMBEDDINGGEMMA_2,
      ...(request.url === "/tokens" ? { counts: input.texts.map(() => 10) }
        : { vectors: input.texts.map(() => [1, ...Array(767).fill(0)]) }),
    }));
  });
  await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
  const portPicker = createServer();
  await new Promise((resolve) => portPicker.listen(0, "127.0.0.1", resolve));
  const debugPort = portPicker.address().port;
  await new Promise((resolve) => portPicker.close(resolve));
  const env = {
    ...process.env, APPDATA: join(root, "appdata"), HOME: root, USERPROFILE: root,
    REGENIC_REPO_ROOT: repo, REGENIC_DATABASE: database, REGENIC_BLOB_ROOT: blobRoot,
    REGENIC_ORG: "smoke-owner", NODE_BINARY: process.execPath,
    REGENIC_MODEL_DRIVER: "none", REGENIC_EMBEDDING_DRIVER: "local_http",
    REGENIC_EMBEDDING_BASE_URL: `http://127.0.0.1:${model.address().port}`,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  const child = spawn(require("electron"), [".", `--user-data-dir=${profile}`,
    `--remote-debugging-port=${debugPort}`], { cwd: desktop, env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-6000); });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  let ws;
  let sequence = 0;
  const pending = new Map();
  let confirmed = 0;
  function command(method, params = {}) {
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 30_000);
      pending.set(id, (message) => {
        clearTimeout(timer);
        if (message.error) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async function api(path, body) {
    const init = body === undefined ? {} : {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    };
    return evaluate(`(async () => {
      const settings = await window.regenic.getKernelSettings();
      const response = await fetch(settings.activeOrigin + ${JSON.stringify(path)}, ${JSON.stringify(init)});
      const value = await response.json();
      if (!response.ok) throw new Error(JSON.stringify(value));
      return value;
    })()`);
  }
  const click = (selector) => evaluate(`(() => {
    const button = document.querySelector(${JSON.stringify(selector)});
    if (!button || button.disabled) throw new Error("Button unavailable: " + ${JSON.stringify(selector)});
    button.click();
  })()`);
  async function search() {
    await waitFor(() => evaluate('Boolean(document.querySelector(\'nav button[aria-label="Search"]\'))'), "console navigation");
    await click('nav button[aria-label="Search"]');
    await waitFor(() => evaluate('Boolean(document.querySelector("#context-query"))'), "search page");
    await evaluate('document.querySelector("#context-query").focus(); document.querySelector("#context-query").select()');
    await command("Input.insertText", { text: "RG-SMOKE" });
    await evaluate('document.querySelector(".semantic-search-form").requestSubmit()');
    await waitFor(() => evaluate('document.querySelectorAll(".semantic-results > li").length === 1'), "search results");
  }
  let cleanExit = false;
  try {
    const target = await waitFor(async () => {
      try {
        const targets = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((response) => response.json());
        return targets.find((target) => target.type === "page" && target.url.includes("surface=console"));
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        return null;
      }
    }, "Electron console", 60_000);
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id); }
      if (message.method === "Page.javascriptDialogOpening") {
        confirmed++;
        void command("Page.handleJavaScriptDialog", { accept: true }).catch((error) => {
          console.error("Could not accept the smoke-test confirmation", error);
        });
      }
    });
    await command("Page.enable");
    await waitFor(() => evaluate("Boolean(window.regenic?.getSemanticRuntime)"), "preload bridge");
    assert.equal((await evaluate("window.regenic.getSemanticRuntime()")).installed, false);
    await api(`/v1/me/inbox/${encodeURIComponent(eventId)}/fold`, {});
    await search();
    await click(".semantic-results > li button");
    await waitFor(() => evaluate('Boolean(document.querySelector("dialog .search-source-text"))'), "authorized source");
    assert.equal(await evaluate('document.querySelectorAll("dialog .search-source-text img").length'), 0);
    await click("dialog button.primary");
    await waitFor(() => evaluate('Boolean(document.querySelector(".thread-window-item.is-context-evidence"))'), "original message highlight");
    assert.ok((await evaluate('document.querySelector(".thread-window-item.is-context-evidence").textContent')).includes("RG-SMOKE"));
    assert.equal((await api(`/v1/me/inbox/${encodeURIComponent(eventId)}`)).hidden, true);

    assert.equal((await api("/v1/me/context/embedding/index", {})).failed, 1);
    await click('nav button[aria-label="Settings"]');
    await waitFor(() => evaluate('Boolean(document.querySelector(".semantic-generation"))'), "generation diagnostics");
    await waitFor(() => evaluate('document.querySelector(".semantic-generation").textContent.includes("Model revision/descriptor mismatch")'), "localized failure explanation");
    assert.equal(await evaluate('Array.from(document.querySelectorAll(".semantic-settings button")).find(b => b.textContent === "Download and install").disabled'), true);
    broken = false;
    await click(".semantic-generation button");
    await waitFor(() => evaluate('document.querySelector(".semantic-settings").textContent.includes("Requeued 1 jobs.")'), "bounded retry confirmation");
    assert.equal(confirmed, 1);
    const indexed = await api("/v1/me/context/embedding/index", {});
    assert.ok(indexed.processed === 1 || (await api("/v1/me/context/embedding/status")).generations[0].jobs.succeeded === 1);

    await search();
    await ingest("revise", "Updated RG-SMOKE source.");
    await click(".semantic-results > li button");
    await waitFor(() => evaluate('document.querySelector("dialog")?.textContent.includes("This result is no longer current")'), "stale source rejection");
    assert.equal(await evaluate('document.querySelectorAll("dialog .search-source-text").length'), 0);
    await click("dialog header button");
    await evaluate('window.regenic.setKernelSettings({ mode: "local" })');
    await waitFor(() => evaluate('document.querySelectorAll(".semantic-results > li").length === 0'), "origin reset");
    console.log("PASS: actual Electron source preview/navigation/highlight, bounded recovery, stale-source rejection and origin reset (synthetic inference)");
  } catch (error) {
    console.error(stderr);
    throw error;
  } finally {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ id: ++sequence, method: "Runtime.evaluate", params: { expression: "window.regenic.quitApp()" } }));
    }
    const result = await Promise.race([exited, new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 10_000);
      timer.unref();
    })]);
    ws?.close();
    model.closeAllConnections();
    await new Promise((resolve) => model.close(resolve));
    if (!result) child.kill("SIGKILL");
    cleanExit = result?.code === 0 && !existsSync(join(data, "regenic.store.lock"));
    if (cleanExit) rmSync(root, { recursive: true, force: true });
    else throw new Error(`Electron did not quit cleanly; inspect isolated fixture: ${root}`);
  }
  assert.ok(cleanExit);
  console.log("PASS: clean Electron quit and store-lock release; isolated fixture removed");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
