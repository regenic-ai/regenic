const assert = require("node:assert/strict");
const { execFileSync, spawn } = require("node:child_process");
const { existsSync, mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } = require("node:fs");
const { createHash, randomUUID } = require("node:crypto");
const { createServer } = require("node:http");
const { createRequire } = require("node:module");
const { observeChild, runWithFailureCleanup } = require("./smoke-process.cjs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");

const desktop = resolve(__dirname, "..");
const repo = resolve(desktop, "../..");
const apiRequire = createRequire(join(repo, "apps", "api", "package.json"));
const { SqliteAuthorityStore } = apiRequire("@regenic/authority-store/sqlite");
const { IngestionService } = apiRequire("@regenic/domain");
const { FsBlobStore } = apiRequire("@regenic/blob-store");
const { EMBEDDINGGEMMA_2 } = apiRequire("@regenic/embedding-provider");
const Database = createRequire(apiRequire.resolve("@regenic/vector-index"))("better-sqlite3");
const root = mkdtempSync(join(tmpdir(), "regenic-semantic-electron-"));
let ownedModel;
let ownedExecutor;
let ownedElectron;
let ownedSocket;
let crashedKernelPid;
const profile = join(root, "profile");
const data = join(root, "data");
const database = join(data, "authority.db");
const blobRoot = join(data, "blobs");
const acknowledgmentCommitArmPath = join(root, "acknowledgment-commit.arm");
const acknowledgmentCommitBarrierPath = join(root, "acknowledgment-commit.pending");
mkdirSync(data);

function processRunning(pid) {
  try {
    const state = execFileSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" }).trim();
    return Boolean(state) && !state.startsWith("Z");
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
}

function killCrashedKernel() {
  if (!crashedKernelPid) return;
  try {
    process.kill(crashedKernelPid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

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

async function seedLifecycleWork(executorType, statuses = ["completed", "failed"], senderId, completionPolicyVersion, hideOnSuccess) {
  const authority = new SqliteAuthorityStore(database);
  const fixtures = [];
  try {
    for (const status of statuses) {
      const writeBack = status.startsWith("write_back_");
      const target = status === "inflight" || writeBack ? "completed"
        : status === "retryable_failure" ? "failed" : status;
      const now = new Date().toISOString();
      const marker = `LIFECYCLE-${status.toUpperCase()}`;
      const ingested = await new IngestionService(new FsBlobStore(blobRoot), authority).ingest({
        schema_version: "1.0", connector_id: "lifecycle-smoke", org_id: "smoke-owner",
        delivery_id: marker, received_at: now,
        records: [{
          operation: "create", source: "lifecycle-smoke", external_id: `${status}:task`,
          occurred_at: now, actor: { id: "person" }, scope: { id: status }, type: "task",
          content: [{ role: "body", media_type: "text/plain", text: `${marker}: review this task result.` }],
        }],
      });
      assert.equal(ingested.records[0].status, "accepted");
      const event = await authority.getEvent("smoke-owner", ingested.records[0].event_id);
      const observed = await authority.getWorkItemByThread("smoke-owner", event.thread_id);
      const recipeId = `lifecycle-${status}`;
      await authority.putRecipe({
        id: recipeId, org_id: "smoke-owner", name: marker,
        match: { record_class: "task" }, trigger: { kind: "push" },
        executor_type: executorType, executor_config: {}, include_context: false,
        can_write_back: writeBack, enabled: false, created_at: now, updated_at: now,
        hide_on_success: hideOnSuccess ?? true,
      });
      const bound = await authority.observeWorkItem({
        expected_item: observed, item: { ...observed, recipe_id: recipeId, updated_at: now },
      });
      assert.equal(bound.outcome, "applied");
      const pending = {
        id: `run-lifecycle-${status}`, org_id: "smoke-owner", work_item_id: observed.id,
        recipe_id: recipeId, executor_type: executorType, status: "running",
        start_state: "pending", write_back_required: writeBack, trigger_kind: "push",
        ...(completionPolicyVersion === 1 ? { completion_policy_version: 1 } : {}),
        ...(hideOnSuccess !== undefined ? { hide_on_success: hideOnSuccess } : {}),
        ...(writeBack ? { write_back_target: {
          installation_id: senderId, source: "lifecycle-smoke", target: `${status}-results`,
        } } : {}),
        created_at: now, updated_at: now,
      };
      assert.equal(await authority.claimWorkRunStart({ expected_item: bound.item, run: pending }), true);
      const submitted = await authority.checkpointWorkRunStart({
        expected_item: await authority.getWorkItem("smoke-owner", observed.id),
        expected_run: await authority.getWorkRun("smoke-owner", pending.id),
        kind: "submitted", external_run_id: `lifecycle-smoke:${status}`, now,
      });
      assert.equal(submitted.outcome, "applied");
      const running = await authority.commitWorkObservation({
        expected_item: submitted.item, expected_run: submitted.run,
        handle: {
          external_run_id: submitted.run.external_run_id, status: "running",
        },
        can_write_back: writeBack, trigger_kind: "push", now,
      });
      assert.equal(running.outcome, "applied");
      fixtures.push({ marker, target, event, item: running.transition.item, run: running.transition.run });
    }
    return fixtures;
  } finally { authority.close(); }
}

async function checkLifecycleWork(fixtures) {
  const authority = new SqliteAuthorityStore(database, { readonly: true });
  try {
    for (const fixture of fixtures) {
      const item = await authority.getWorkItem("smoke-owner", fixture.item.id);
      assert.equal(item.status, fixture.item.status);
      assert.equal(item.current_run_id, fixture.run.id);
      assert.equal(item.acknowledged_run_id, fixture.run.id);
      assert.equal(item.version, fixture.item.version + 1);
      assert.deepEqual(await authority.getWorkRun("smoke-owner", fixture.run.id), fixture.run);
      assert.equal((await authority.listWorkRuns("smoke-owner", item.id)).length, 1);
      assert.equal(await authority.getWorkDeliveryByItem("smoke-owner", item.id), null);
      assert.equal((await authority.getDisposition(fixture.event.id)).disposition, "outside_current_work");
      const pref = await authority.getConversationPref("smoke-owner", fixture.event.thread_id);
      assert.equal(pref?.visibility_version ?? 0, fixture.item.visibility_intent_version);
      if (item.status === "done") {
        assert.equal(pref.hidden, true);
        assert.equal(pref.hidden_reason, "policy");
      }
    }
    assert.deepEqual(await authority.listCancellationJobs("smoke-owner"), []);
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
  ownedModel = model;
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
  const pluginRoot = join(root, "lifecycle-sender");
  mkdirSync(pluginRoot);
  writeFileSync(join(pluginRoot, "package.json"), JSON.stringify({
    name: "lifecycle-smoke-sender", main: "index.cjs",
    regenic: { plugin: true, contributes: { drivers: ["sender"] } },
  }));
  writeFileSync(join(pluginRoot, "index.cjs"), `
    exports.sender = {
      connector_type: "lifecycle-smoke-sender", source: "lifecycle-smoke",
      capabilities() { return { sync: false, reply: true, create: false }; },
      async resolveStreams() { return []; },
      matchesThread(_installation, thread) { return thread.source === "lifecycle-smoke"; },
      ownsThread(_installation, thread) { return thread.source === "lifecycle-smoke"; },
      installCatalog() {
        return { name: "Lifecycle sender", allow_multiple: false,
          fields: [{ key: "base_url", label: "Loopback sender URL", type: "string", required: true }] };
      },
      install({ id, org_id, config, now }) {
        return { id, org_id, config, connector_type: "lifecycle-smoke-sender",
          status: "enabled", created_at: now, updated_at: now };
      },
      async bindEgress(installation) {
        return { async send(input) {
          const response = await fetch(installation.config.base_url + "/send", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify(input),
          });
          if (!response.ok) throw new Error("Loopback sender failed: " + response.status);
          return response.json();
        } };
      },
      outboundId(thread, receipt) { return thread.target + ":" + receipt.rpc_id; },
    };
  `);
  env.REGENIC_CHANNEL_PLUGIN = pluginRoot;
  const sqliteModulePath = createRequire(apiRequire.resolve("@regenic/authority-store/sqlite"))
    .resolve("better-sqlite3");
  const preloaderPath = join(root, "sqlite-ack-commit-preloader.cjs");
  writeFileSync(preloaderPath, `
    const { isMainThread, workerData } = require("node:worker_threads");
    if (!isMainThread && workerData?.path && workerData.readonly !== true) {
      const { existsSync, unlinkSync, writeFileSync } = require("node:fs");
      const Database = require(${JSON.stringify(sqliteModulePath)});
      const prepare = Database.prototype.prepare;
      let held = false;
      Database.prototype.prepare = function (sql, ...options) {
        const statement = prepare.call(this, sql, ...options);
        if (!sql.includes("'work_acknowledged'")) return statement;
        return new Proxy(statement, {
          get(target, property) {
            if (property === "run") {
              return (...args) => {
                const result = target.run(...args);
                if (!held && existsSync(${JSON.stringify(acknowledgmentCommitArmPath)})) {
                  held = true;
                  unlinkSync(${JSON.stringify(acknowledgmentCommitArmPath)});
                  writeFileSync(${JSON.stringify(acknowledgmentCommitBarrierPath)}, "pending");
                  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
                }
                return result;
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      };
    }
  `);
  env.NODE_OPTIONS = [
    env.NODE_OPTIONS,
    `--require=${JSON.stringify(preloaderPath)}`,
  ].filter(Boolean).join(" ");
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  let stderr = "";
  let child;
  let exited;
  function launchElectron() {
    child = spawn(require("electron"), [".", `--user-data-dir=${profile}`,
      `--remote-debugging-port=${debugPort}`], { cwd: desktop, env, stdio: ["ignore", "ignore", "pipe"] });
    ownedElectron = observeChild(child);
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-6000); });
    exited = ownedElectron.exited;
  }
  launchElectron();
  let ws;
  let sequence = 0;
  const pending = new Map();
  let confirmed = 0;
  let pageLoad;
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
  async function reloadRenderer() {
    pageLoad = Promise.withResolvers();
    let timer;
    try {
      await command("Page.reload");
      await Promise.race([
        pageLoad.promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("Renderer reload timed out")), 30_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      pageLoad = undefined;
    }
    await waitFor(() => evaluate('Boolean(document.querySelector(\'nav button[aria-label="Inbox"]\'))'),
      "reloaded console navigation");
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
  async function connectRenderer() {
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
    ownedSocket = ws;
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id) { pending.get(message.id)?.(message); pending.delete(message.id); }
      if (message.method === "Page.loadEventFired") pageLoad?.resolve();
      if (message.method === "Page.javascriptDialogOpening") {
        confirmed++;
        void command("Page.handleJavaScriptDialog", { accept: true }).catch((error) => {
          console.error("Could not accept the smoke-test confirmation", error);
        });
      }
    });
    await command("Page.enable");
    await waitFor(() => evaluate("Boolean(window.regenic?.getSemanticRuntime)"), "preload bridge");
  }
  let cleanExit = false;
  try {
    await connectRenderer();
    assert.equal((await evaluate("window.regenic.getSemanticRuntime()")).installed, false);
    const inboxItem = await api(`/v1/me/inbox/${encodeURIComponent(eventId)}`);
    await api(`/v1/me/inbox/${encodeURIComponent(eventId)}/fold`, {
      expected_visibility_version: inboxItem.visibility_version,
      command_id: randomUUID(),
      issued_at: new Date().toISOString(),
    });
    await search();
    await waitFor(() => evaluate('Boolean(document.querySelector(".search-message-main"))'), "search source result");
    assert.ok((await evaluate('document.querySelector(".search-message-main").textContent')).includes("<img src=x onerror=alert(1)>"));
    assert.equal(await evaluate('document.querySelectorAll(".semantic-results img").length'), 0);
    await click(".search-message-main");
    await waitFor(() => evaluate('Boolean(document.querySelector(".thread-window-item.is-context-evidence"))'), "original message highlight");
    assert.ok((await evaluate('document.querySelector(".thread-window-item.is-context-evidence").textContent')).includes("RG-SMOKE"));
    assert.equal(await evaluate('document.querySelectorAll(".thread-window-item.is-context-evidence img").length'), 0);
    assert.equal((await api(`/v1/me/inbox/${encodeURIComponent(eventId)}`)).hidden, true);

    await api("/v1/me/context/embedding/index", {});
    const failedGeneration = await waitFor(async () => {
      const status = await api("/v1/me/context/embedding/status");
      const generation = status.generations[0];
      return generation && generation.jobs.failed + generation.jobs.quarantined === 1
        ? generation
        : null;
    }, "synthetic embedding failure");
    assert.equal(failedGeneration.jobs.failed + failedGeneration.jobs.quarantined, 1);
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
    await click(".search-message-main");
    await waitFor(() => evaluate('document.querySelector("[role=alert]")?.textContent.includes("This result is no longer current")'), "stale source rejection");
    await evaluate('window.regenic.setKernelSettings({ mode: "local" })');
    await waitFor(() => evaluate('document.querySelectorAll(".semantic-results > li").length === 0'), "origin reset");
    const executionStates = new Map();
    const unexpectedExecution = [];
    let manualRetryWorkItemId;
    const manualRetryRequests = [];
    const deliveryModes = new Map();
    const deliveryRequests = [];
    const deliveredResults = [];
    ownedExecutor = createServer((request, response) => {
      if (request.method === "POST" && request.url === "/send") {
        let raw = "";
        request.on("data", (chunk) => { raw += chunk; });
        request.on("end", () => {
          const input = JSON.parse(raw);
          deliveryRequests.push(input);
          const mode = deliveryModes.get(input.target.scope_id);
          if (mode === "accept" || mode === "sent") deliveredResults.push(input);
          if (mode === "sent" || mode === "not_sent") {
            response.destroy();
            return;
          }
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({
            accepted: mode === "accept", rpc_id: `receipt:${input.target.scope_id}`,
          }));
        });
        return;
      }
      if (request.method === "POST" && request.url === "/v1/runs" && manualRetryWorkItemId) {
        let raw = "";
        request.on("data", (chunk) => { raw += chunk; });
        request.on("end", () => {
          let body;
          try {
            body = JSON.parse(raw);
          } catch {
            unexpectedExecution.push("POST /v1/runs (invalid JSON)");
            response.writeHead(400).end(JSON.stringify({ error: "Invalid JSON" }));
            return;
          }
          if (body.work_item_id !== manualRetryWorkItemId) {
            unexpectedExecution.push(`POST /v1/runs for unexpected work item ${body.work_item_id}`);
            response.writeHead(404).end(JSON.stringify({ error: "Unexpected work item" }));
            return;
          }
          const externalRunId = `lifecycle-smoke:manual-retry-${manualRetryRequests.length + 1}`;
          manualRetryRequests.push({ body, external_run_id: externalRunId });
          executionStates.set(externalRunId, { status: "running" });
          response.setHeader("content-type", "application/json");
          response.end(JSON.stringify({ external_run_id: externalRunId, status: "running" }));
        });
        return;
      }
      const match = /^\/v1\/runs\/([^/]+)$/.exec(request.url);
      const id = match ? decodeURIComponent(match[1]) : undefined;
      const state = executionStates.get(id);
      response.setHeader("content-type", "application/json");
      if (request.method !== "GET" || !state) {
        unexpectedExecution.push(`${request.method} ${request.url}`);
        response.writeHead(404).end(JSON.stringify({ error: "Unexpected execution" }));
        return;
      }
      response.end(JSON.stringify({ external_run_id: id, ...state }));
    });
    await new Promise((resolve) => ownedExecutor.listen(0, "127.0.0.1", resolve));
    const installedExecutor = await api("/v1/me/executors", {
      kind: "http", name: "Lifecycle smoke",
      config: { base_url: `http://127.0.0.1:${ownedExecutor.address().port}` },
    });
    for (const status of ["completed", "failed"]) {
      executionStates.set(`lifecycle-smoke:${status}`, { status: "running" });
    }
    const lifecycleWork = await seedLifecycleWork(installedExecutor.id);
    await reloadRenderer();
    await click('nav button[aria-label="Inbox"]');
    for (const fixture of lifecycleWork) {
      const source = await api(`/v1/me/inbox/${fixture.event.id}`);
      assert.equal(source.work.run_id, fixture.run.id);
      await waitFor(() => evaluate('Boolean(document.querySelector(".list-views button"))'), "inbox list tabs");
      await click(`.list-views button:nth-child(${source.hidden ? 2 : 1})`);
      const findRow = `[...document.querySelectorAll(".item")].find(row => row.textContent.includes(${JSON.stringify(fixture.marker)}))`;
      await waitFor(() => evaluate(`Boolean(${findRow})`), `${fixture.marker} inbox row`);
      await evaluate(`${findRow}.click()`);
      await waitFor(async () => {
        const authority = new SqliteAuthorityStore(database, { readonly: true });
        try {
          return (await authority.getConversationPref("smoke-owner", fixture.event.thread_id))
            ?.last_read_external_id === fixture.event.external_id;
        } finally { authority.close(); }
      }, `${fixture.marker} read cursor committed while the run is active`);
      executionStates.set(fixture.run.external_run_id, {
        status: fixture.target, result: { summary: `${fixture.marker}: execution ${fixture.target}.` },
      });
      const title = fixture.target === "completed"
        ? "Mark this exact run's result as reviewed"
        : "Stop automatic retries for this reviewed failure";
      const button = `.thread-actions button[title="${title}"]`;
      await waitFor(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(button)}))`),
        `${fixture.marker} result acknowledgment button`);
      const authority = new SqliteAuthorityStore(database, { readonly: true });
      try {
        fixture.item = await authority.getWorkItem("smoke-owner", fixture.item.id);
        fixture.run = await authority.getWorkRun("smoke-owner", fixture.run.id);
        assert.equal(fixture.run.status, fixture.target);
        assert.equal(fixture.item.acknowledged_run_id, undefined);
      } finally { authority.close(); }
      await click(button);
      await waitFor(async () => {
        const authority = new SqliteAuthorityStore(database, { readonly: true });
        try {
          return (await authority.getWorkItem("smoke-owner", fixture.item.id)).acknowledged_run_id === fixture.run.id;
        } finally { authority.close(); }
      }, `${fixture.marker} acknowledgment committed through the renderer`);
      await waitFor(() => evaluate(`!document.querySelector(${JSON.stringify(button)})`),
        `${fixture.marker} reviewed action disappears`);
    }
    await checkLifecycleWork(lifecycleWork);
    async function checkElectronCrash() {
      if (process.platform === "win32") {
        console.log("SKIP: Electron-crash acceptance requires POSIX process ownership inspection");
        return;
      }
      const lockPath = join(data, "regenic.store.lock");
      const staleLock = readFileSync(lockPath, "utf8");
      assert.equal(JSON.parse(staleLock).pid, child.pid);
      const children = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" })
        .trim().split("\n").map((line) => line.trim().split(/\s+/).map(Number))
        .filter(([, ppid]) => ppid === child.pid);
      const kernelPids = children.filter(([pid]) =>
        execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" })
          .trim() === `${process.execPath} ${join(repo, "apps/api/dist/main.js")}`);
      assert.equal(kernelPids.length, 1, "Exactly one owned API kernel must be present");
      crashedKernelPid = kernelPids[0][0];
      child.kill("SIGKILL");
      assert.deepEqual(await ownedElectron.stop(), { code: null, signal: "SIGKILL" });
      await waitFor(() => !processRunning(crashedKernelPid), "API kernel shuts down after its Electron parent exits");
      crashedKernelPid = undefined;
      ws.close();
      assert.equal(readFileSync(lockPath, "utf8"), staleLock, "Process exit must leave the real stale store lock");
      await checkLifecycleWork(lifecycleWork);
      launchElectron();
      await connectRenderer();
      await waitFor(async () => {
        const settings = await evaluate("window.regenic.getKernelSettings()");
        return settings.activeOrigin && (await api(`/v1/me/inbox/${lifecycleWork[0].event.id}`)).work;
      }, "restarted desktop API");
      assert.equal(JSON.parse(readFileSync(lockPath, "utf8")).pid, child.pid);
      await checkLifecycleWork(lifecycleWork);
      await click('nav button[aria-label="Inbox"]');
      for (const fixture of lifecycleWork) {
        const source = await api(`/v1/me/inbox/${fixture.event.id}`);
        assert.equal(source.work.acknowledged_run_id, fixture.run.id);
        assert.equal(source.hidden, fixture.target === "completed");
        if (fixture.target === "failed") {
          for (const list of ["shown", "hidden"]) {
            const heads = await api(`/v1/me/inbox?heads=true&split=true&list=${list}`);
            assert.equal([...heads.pinned, ...heads.live, ...heads.active_work]
              .some((item) => item.event.id === fixture.event.id), false,
            "Reviewed failure is outside current work, not a pending list entry");
          }
          continue;
        }
        await waitFor(() => evaluate('Boolean(document.querySelector(".list-views button"))'), "restarted inbox tabs");
        await click(`.list-views button:nth-child(${source.hidden ? 2 : 1})`);
        const row = `[...document.querySelectorAll(".item")].find(row => row.textContent.includes(${JSON.stringify(fixture.marker)}))`;
        await waitFor(() => evaluate(`Boolean(${row})`), `${fixture.marker} row after full process crash`);
        await evaluate(`${row}.click()`);
        await waitFor(() => evaluate(`document.querySelector(".thread-pane")?.textContent.includes(${JSON.stringify(fixture.marker)})`),
          `${fixture.marker} pane after full process crash`);
        const reviewedActions = `.thread-actions button[title="Mark this exact run's result as reviewed"], .thread-actions button[title="Stop automatic retries for this reviewed failure"]`;
        assert.equal(await evaluate(`Boolean(document.querySelector(${JSON.stringify(reviewedActions)}))`), false);
      }
      await checkLifecycleWork(lifecycleWork);
      console.log("PASS: Electron SIGKILL closes its owned API kernel through the parent-PID monitor; same-profile restart reclaims the stale store lock and restores both inbox projections");
    }
    async function checkElectronAcknowledgmentCrash() {
      if (process.platform === "win32") {
        console.log("SKIP: in-flight acknowledgment crash acceptance requires POSIX process ownership inspection");
        return;
      }
      const [fixture] = await seedLifecycleWork(installedExecutor.id, ["inflight"]);
      executionStates.set(fixture.run.external_run_id, { status: "running" });
      await click('nav button[aria-label="Inbox"]');
      const source = await api(`/v1/me/inbox/${fixture.event.id}`);
      await waitFor(() => evaluate('Boolean(document.querySelector(".list-views button"))'),
        "in-flight acknowledgment inbox tabs");
      await click(`.list-views button:nth-child(${source.hidden ? 2 : 1})`);
      const row = `[...document.querySelectorAll(".item")].find(item => item.textContent.includes(${JSON.stringify(fixture.marker)}))`;
      await waitFor(() => evaluate(`Boolean(${row})`), `${fixture.marker} inbox row`);
      await evaluate(`${row}.click()`);
      await waitFor(async () => {
        const authority = new SqliteAuthorityStore(database, { readonly: true });
        try {
          return (await authority.getConversationPref("smoke-owner", fixture.event.thread_id))
            ?.last_read_external_id === fixture.event.external_id;
        } finally { authority.close(); }
      }, `${fixture.marker} read cursor committed while the run is active`);
      executionStates.set(fixture.run.external_run_id, {
        status: "completed", result: { summary: `${fixture.marker}: execution completed.` },
      });
      const button = `.thread-actions button[title="Mark this exact run's result as reviewed"]`;
      await waitFor(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(button)}))`),
        `${fixture.marker} result acknowledgment button`);

      const readState = async () => {
        const authority = new SqliteAuthorityStore(database, { readonly: true });
        try {
          return {
            item: await authority.getWorkItem("smoke-owner", fixture.item.id),
            run: await authority.getWorkRun("smoke-owner", fixture.run.id),
            disposition: await authority.getDisposition(fixture.event.id),
            pref: await authority.getConversationPref("smoke-owner", fixture.event.thread_id),
            runs: await authority.listWorkRuns("smoke-owner", fixture.item.id),
            delivery: await authority.getWorkDeliveryByItem("smoke-owner", fixture.item.id),
            jobs: await authority.listCancellationJobs("smoke-owner"),
          };
        } finally { authority.close(); }
      };
      const before = await readState();
      assert.equal(before.run.status, "completed");
      assert.equal(before.item.acknowledged_run_id, undefined);
      assert.equal(before.disposition.disposition, "current_work");
      writeFileSync(acknowledgmentCommitArmPath, "armed");
      await click(button);
      await waitFor(() => existsSync(acknowledgmentCommitBarrierPath),
        "renderer acknowledgment is inside the SQLite transaction before commit");
      assert.deepEqual(await readState(), before,
        "A concurrent reader must not observe a partially acknowledged result");

      const lockPath = join(data, "regenic.store.lock");
      const staleLock = readFileSync(lockPath, "utf8");
      const children = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" })
        .trim().split("\n").map((line) => line.trim().split(/\s+/).map(Number))
        .filter(([, ppid]) => ppid === child.pid);
      const kernelPids = children.filter(([pid]) =>
        execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" })
          .trim() === `${process.execPath} ${join(repo, "apps/api/dist/main.js")}`);
      assert.equal(kernelPids.length, 1, "Exactly one owned API kernel must be present");
      crashedKernelPid = kernelPids[0][0];
      const shutdownStartedAt = Date.now();
      child.kill("SIGKILL");
      assert.deepEqual(await ownedElectron.stop(), { code: null, signal: "SIGKILL" });
      await waitFor(() => !processRunning(crashedKernelPid),
        "API kernel shuts down after its Electron parent exits with an acknowledgment in flight");
      assert.ok(Date.now() - shutdownStartedAt >= 4_500,
        "The blocked writer must be terminated by the sidecar shutdown deadline");
      assert.ok(Date.now() - shutdownStartedAt < 15_000,
        "The sidecar shutdown deadline must bound in-flight request recovery");
      crashedKernelPid = undefined;
      ws.close();
      assert.equal(readFileSync(lockPath, "utf8"), staleLock,
        "The in-flight crash must leave the real stale store lock");
      assert.deepEqual(await readState(), before,
        "The in-flight acknowledgment must roll back when the owned kernel exits");

      launchElectron();
      await connectRenderer();
      await waitFor(async () => {
        const settings = await evaluate("window.regenic.getKernelSettings()");
        return settings.activeOrigin && (await api(`/v1/me/inbox/${fixture.event.id}`)).work;
      }, "restarted desktop API after in-flight acknowledgment");
      assert.equal(JSON.parse(readFileSync(lockPath, "utf8")).pid, child.pid);
      assert.deepEqual(await readState(), before);
      const recoveredSource = await api(`/v1/me/inbox/${fixture.event.id}`);
      assert.equal(recoveredSource.work.acknowledged_run_id, undefined);
      await click('nav button[aria-label="Inbox"]');
      await waitFor(() => evaluate('Boolean(document.querySelector(".list-views button"))'),
        "recovered in-flight acknowledgment inbox tabs");
      await click(`.list-views button:nth-child(${recoveredSource.hidden ? 2 : 1})`);
      const recoveredRow = `[...document.querySelectorAll(".item")].find(item => item.textContent.includes(${JSON.stringify(fixture.marker)}))`;
      await waitFor(() => evaluate(`Boolean(${recoveredRow})`), `${fixture.marker} row after desktop crash`);
      await evaluate(`${recoveredRow}.click()`);
      await waitFor(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(button)}))`),
        `${fixture.marker} acknowledgment action after desktop crash`);
      await click(button);
      await waitFor(async () => (await readState()).item.acknowledged_run_id === fixture.run.id,
        `${fixture.marker} result acknowledged after desktop restart`);
      const recovered = await readState();
      assert.equal(recovered.item.version, before.item.version + 1);
      assert.deepEqual(recovered.run, before.run);
      assert.equal(recovered.disposition.disposition, "outside_current_work");
      assert.equal(recovered.pref.hidden, true);
      assert.equal(recovered.pref.hidden_reason, "policy");
      assert.equal(recovered.runs.length, 1);
      assert.equal(recovered.delivery, null);
      assert.deepEqual(recovered.jobs, []);
      console.log("PASS: killing Electron during a renderer acknowledgment rolls back the owned API transaction; same-profile restart restores the pending result for one exact confirmation");
    }
    await click('nav button[aria-label="Settings"]');
    await waitFor(() => evaluate('Boolean(Array.from(document.querySelectorAll(".semantic-consent")).find(label => label.textContent.includes("Visual analysis")))'), "content permissions");
    assert.equal((await evaluate("window.regenic.getSemanticRuntime()")).visualEnabled, false);
    const toggleVisual = () => evaluate('Array.from(document.querySelectorAll(".semantic-consent")).find(label => label.textContent.includes("Visual analysis")).querySelector("input").click()');
    const applyVisual = () => evaluate('Array.from(document.querySelectorAll(".semantic-settings button")).find(button => ["Save content permissions", "Apply permissions and restart"].includes(button.textContent)).click()');
    await toggleVisual();
    await waitFor(() => evaluate('Array.from(document.querySelectorAll(".semantic-settings button")).some(button => button.textContent === "Save content permissions")'), "staged visual opt-in");
    assert.equal((await evaluate("window.regenic.getSemanticRuntime()")).visualEnabled, false);
    const originBeforeConsent = await evaluate("window.regenic.getKernelSettings().then(settings => settings.activeOrigin)");
    await applyVisual();
    await waitFor(async () => {
      const runtime = await evaluate("window.regenic.getSemanticRuntime()");
      assert.equal(runtime.error, undefined);
      return runtime.visualEnabled && !runtime.busy && runtime.canManage;
    }, "applied visual opt-in");
    assert.equal(await evaluate("window.regenic.getKernelSettings().then(settings => settings.activeOrigin)"), originBeforeConsent);
    await waitFor(() => evaluate('Array.from(document.querySelectorAll(".semantic-consent")).find(label => label.textContent.includes("Visual analysis"))?.querySelector("input")?.checked'), "applied checkbox");
    await toggleVisual();
    await waitFor(() => evaluate('Array.from(document.querySelectorAll(".semantic-settings button")).some(button => button.textContent === "Save content permissions")'), "staged visual opt-out");
    const reader = new Database(`${database}.vector.db`, { readonly: true });
    try {
      reader.exec("BEGIN");
      reader.prepare("SELECT * FROM chunks").all();
      await applyVisual();
      const failed = await waitFor(async () => {
        const runtime = await evaluate("window.regenic.getSemanticRuntime()");
        return runtime.error && !runtime.busy ? runtime : null;
      }, "failed index cleanup");
      assert.equal(failed.visualEnabled, false);
      assert.equal(failed.canManage, true);
      await waitFor(() => evaluate('Boolean(document.querySelector(\'nav button[aria-label="Search"]\'))'),
        "console navigation after failed kernel restart");
      await click('nav button[aria-label="Search"]');
      await waitFor(() => evaluate('Boolean(document.querySelector("#context-query"))'), "leave failed settings");
      await click('nav button[aria-label="Settings"]');
      await waitFor(() => evaluate('Array.from(document.querySelectorAll(".semantic-settings button")).some(button => button.textContent === "Apply permissions and restart" && !button.disabled)'), "reopened settings recovery without kernel");
    } finally { reader.close(); }
    await waitFor(() => evaluate('Array.from(document.querySelectorAll(".semantic-settings button")).some(button => button.textContent === "Apply permissions and restart")'), "retry permission controls");
    await applyVisual();
    await waitFor(async () => {
      const runtime = await evaluate("window.regenic.getSemanticRuntime()");
      assert.equal(runtime.error, undefined);
      return !runtime.visualEnabled && !runtime.busy && runtime.canManage;
    }, "confirmed visual opt-out");
    assert.equal(confirmed, 3);
    assert.equal((await api("/v1/me/context/embedding/status")).configured, true);
    console.log("PASS: actual permission UI saves opt-in without restarting, confirms opt-out, and recovers failed cleanup with the same saved permission (synthetic inference)");
    const managedRoot = join(profile, "semantic-runtime");
    const python = process.platform === "win32" ? null : join(managedRoot, "venv", "bin", "python");
    if (python) {
      mkdirSync(join(managedRoot, "venv", "bin"), { recursive: true });
      const assets = join(desktop, "out", "main", "embedding");
      const fingerprint = createHash("sha256").update(readFileSync(join(assets, "requirements.txt")))
        .update(readFileSync(join(assets, "serve.py"))).digest("hex");
      writeFileSync(join(managedRoot, "installed.json"), JSON.stringify({ fingerprint }));
      writeFileSync(python, `#!${process.execPath}
const {createServer} = require("node:http");
const args = process.argv.slice(2);
const descriptor = ${JSON.stringify(EMBEDDINGGEMMA_2)};
const runtime = {device:args[args.indexOf("--device")+1] === "auto-mps" ? "mps" : args[args.indexOf("--device")+1],
  precision:args[args.indexOf("--precision")+1],threads:Number(process.env.OMP_NUM_THREADS),visual_enabled:args.includes("--visual")};
const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const input = body ? JSON.parse(body) : {};
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(request.url === "/health" ? {status:"ready",descriptor,runtime} :
    {descriptor,counts:input.texts.map(() => 10),vectors:input.texts.map(() => [1,...Array(767).fill(0)])}));
});
server.listen(Number(args[args.indexOf("--port")+1]),"127.0.0.1");
process.on("SIGTERM",() => server.close(() => process.exit(0)));
`, { mode: 0o755 });
      await waitFor(async () => (await evaluate("window.regenic.getSemanticRuntime()")).installed, "synthetic managed installation");
      await toggleVisual();
      await waitFor(() => evaluate('Array.from(document.querySelectorAll(".semantic-settings button")).some(button => button.textContent === "Save settings and start")'), "combined permission startup");
      await evaluate(`(() => {
        const choose = (labelText, value) => {
          const label = Array.from(document.querySelectorAll("label")).find(item => item.textContent.includes(labelText));
          const select = label?.control;
          if (!select || select.tagName !== "SELECT" || !Array.from(select.options).some(option => option.value === value && !option.disabled)) {
            throw new Error("Missing model parameter option: " + labelText + "=" + value);
          }
          Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(select, value);
          select.dispatchEvent(new Event("change", { bubbles: true }));
        };
        const setRange = (labelText, value) => {
          const label = Array.from(document.querySelectorAll("label")).find(item => item.textContent.includes(labelText));
          const input = label?.control;
          if (!input || input.type !== "range" || Number(value) < Number(input.min) || Number(value) > Number(input.max)) {
            throw new Error("Missing model parameter range: " + labelText + "=" + value);
          }
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        };
        choose("Compute device", "cpu");
        choose("Weight precision", "bfloat16");
        setRange("CPU thread limit", "1");
        choose("Process priority", "normal");
      })()`);
      await evaluate('Array.from(document.querySelectorAll(".semantic-settings button")).find(button => button.textContent === "Save settings and start").click()');
      await waitFor(async () => {
        const runtime = await evaluate("window.regenic.getSemanticRuntime()");
        assert.equal(runtime.error, undefined);
        return runtime.healthy && runtime.visualEnabled && !runtime.busy;
      }, "start using the unapplied visual selection");
      const selectedRuntime = await evaluate("window.regenic.getSemanticRuntime()");
      assert.deepEqual(selectedRuntime.launchSettings, {
        device: "cpu", precision: "bfloat16", threads: 1, priority: "normal",
      });
      assert.deepEqual(selectedRuntime.execution, { device: "cpu", precision: "bfloat16", threads: 1 });
      await waitFor(() => evaluate('Array.from(document.querySelectorAll(".semantic-consent")).find(label => label.textContent.includes("Visual analysis"))?.querySelector("input")?.checked'), "running visual selection");
      await toggleVisual();
      await waitFor(() => evaluate('Array.from(document.querySelectorAll(".semantic-settings button")).some(button => button.textContent === "Apply permissions and restart")'), "running permission change");
      await applyVisual();
      await waitFor(async () => {
        const runtime = await evaluate("window.regenic.getSemanticRuntime()");
        assert.equal(runtime.error, undefined);
        return runtime.healthy && !runtime.visualEnabled && !runtime.busy;
      }, "text-only reload after running opt-out", 90_000);
      assert.equal(confirmed, 4);
      console.log("PASS: combined startup applies selected permission and all launch parameters; running opt-out reloads text-only inference (synthetic managed model)");
    }
    await checkLifecycleWork(lifecycleWork);
    await click('nav button[aria-label="Inbox"]');
    await waitFor(() => evaluate('Boolean(document.querySelector(".list-views button:nth-child(2)"))'),
      "reviewed-result list preference before reload");
    await click(".list-views button:nth-child(2)");
    await waitFor(async () => (await api("/v1/me/prefs")).inbox_list === "hidden",
      "reviewed-result hidden preference saved before reload");
    await reloadRenderer();
    await click('nav button[aria-label="Inbox"]');
    await waitFor(() => evaluate('Boolean(document.querySelector(".list-views button:nth-child(2)"))'),
      "hidden inbox after desktop-triggered kernel restart");
    await click(".list-views button:nth-child(2)");
    const completed = lifecycleWork.find((fixture) => fixture.item.status === "done");
    await waitFor(() => evaluate('Boolean(document.querySelector(".list-views button"))'), "reviewed inbox tabs");
    await click(".list-views button:nth-child(2)");
    const findReviewed = `[...document.querySelectorAll(".item")].find(row => row.textContent.includes(${JSON.stringify(completed.marker)}))`;
    try {
      await waitFor(() => evaluate(`Boolean(${findReviewed})`), "reviewed result remains on hidden list after restart");
    } catch (error) {
      console.error("Reviewed item diagnostics",
        await evaluate(`({
          tabs: [...document.querySelectorAll(".list-views button")].map(b => ({text:b.textContent,selected:b.getAttribute("aria-selected")})),
          rows: [...document.querySelectorAll(".item")].map(r => r.textContent)
        })`),
        await api(`/v1/me/inbox/${completed.event.id}`));
      throw error;
    }
    await evaluate(`${findReviewed}.click()`);
    await waitFor(() => evaluate(`document.querySelector(".thread-pane")?.textContent.includes(${JSON.stringify(completed.marker)})`),
      "reviewed conversation pane");
    const acknowledgeButton = `.thread-actions button[title="Mark this exact run's result as reviewed"]`;
    assert.equal(await evaluate(`Boolean(document.querySelector(${JSON.stringify(acknowledgeButton)}))`), false);
    assert.equal((await api(`/v1/me/inbox/${completed.event.id}`)).work.acknowledged_run_id, completed.run.id);
    await checkLifecycleWork(lifecycleWork);
    assert.deepEqual(unexpectedExecution, []);
    console.log("PASS: real Electron result/failure acknowledgment buttons commit exact runs; reviewed work and hidden projection survive desktop-triggered kernel restarts");
    console.log("PASS: actual Electron search source navigation/highlight, bounded recovery, stale-source rejection and origin reset (synthetic inference)");
    if (python) {
      await evaluate('window.regenic.semanticAction("stop")');
      await waitFor(async () => {
        const runtime = await evaluate("window.regenic.getSemanticRuntime()");
        assert.equal(runtime.error, undefined);
        return !runtime.busy && !runtime.healthy && runtime.canManage;
      }, "managed model stopped before full-process crash");
    }
    if (!process.argv.includes("--skip-crash")) {
      await checkElectronCrash();
      await checkElectronAcknowledgmentCrash();
    }
    const [retryFixture] = await seedLifecycleWork(installedExecutor.id, ["retryable_failure"]);
    executionStates.set(retryFixture.run.external_run_id, {
      status: "failed", result: { summary: "Reviewed failure can be explicitly retried." },
    });
    manualRetryWorkItemId = retryFixture.item.id;
    await click('nav button[aria-label="Inbox"]');
    const retrySource = await api(`/v1/me/inbox/${retryFixture.event.id}`);
    await waitFor(() => evaluate('Boolean(document.querySelector(".list-views button"))'),
      "manual retry inbox tabs");
    await click(`.list-views button:nth-child(${retrySource.hidden ? 2 : 1})`);
    const retryRow = `[...document.querySelectorAll(".item")].find(row => row.textContent.includes(${JSON.stringify(retryFixture.marker)}))`;
    await waitFor(() => evaluate(`Boolean(${retryRow})`), "failed result available for explicit retry");
    await evaluate(`${retryRow}.click()`);
    const failureAcknowledgment =
      `.thread-actions button[title="Stop automatic retries for this reviewed failure"]`;
    await waitFor(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(failureAcknowledgment)}))`),
      "failure acknowledgment action");
    await click(failureAcknowledgment);
    await waitFor(async () => {
      const authority = new SqliteAuthorityStore(database, { readonly: true });
      try {
        return (await authority.getWorkItem("smoke-owner", retryFixture.item.id))
          .acknowledged_run_id === retryFixture.run.id;
      } finally { authority.close(); }
    }, "failure acknowledgment committed through the renderer before manual retry");
    const startReviewedFailure = `.thread-actions button[title="Handle this now"]`;
    await waitFor(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(startReviewedFailure)}))
      && !document.querySelector(${JSON.stringify(failureAcknowledgment)})`),
      "explicit retry action after reviewing failure");
    await click(startReviewedFailure);
    let retryState;
    await waitFor(async () => {
      const authority = new SqliteAuthorityStore(database, { readonly: true });
      try {
        const item = await authority.getWorkItem("smoke-owner", retryFixture.item.id);
        const runs = await authority.listWorkRuns("smoke-owner", item.id);
        retryState = { item, runs, current: await authority.getWorkRun("smoke-owner", item.current_run_id) };
        return item.current_run_id !== retryFixture.run.id && item.status === "running"
          && item.acknowledged_run_id === undefined && runs.length === 2
          && retryState.current.external_run_id === manualRetryRequests[0]?.external_run_id;
      } finally { authority.close(); }
    }, "manual retry creates a new run and clears the old acknowledgment").catch(async (error) => {
      console.error("Manual retry diagnostics", retryState, manualRetryRequests,
        await evaluate(`({
          alerts: [...document.querySelectorAll("[role=alert]")].map(node => node.textContent),
          pane: document.querySelector(".thread-pane")?.textContent
        })`));
      throw error;
    });
    assert.equal(retryState.runs.find((run) => run.id === retryFixture.run.id).status, "failed");
    assert.equal(retryState.current.external_run_id, manualRetryRequests[0]?.external_run_id);
    assert.equal(manualRetryRequests.length, 1, "The renderer must start exactly one new execution");
    assert.equal(manualRetryRequests[0].body.work_item_id, retryFixture.item.id);
    executionStates.set(retryState.current.external_run_id, {
      status: "completed", result: { summary: "The explicitly retried run completed." },
    });
    const retriedResultAcknowledgment =
      `.thread-actions button[title="Mark this exact run's result as reviewed"]`;
    await waitFor(async () => {
      const authority = new SqliteAuthorityStore(database, { readonly: true });
      try {
        const current = await authority.getWorkItem("smoke-owner", retryFixture.item.id);
        const pref = await authority.getConversationPref("smoke-owner", retryFixture.event.thread_id);
        return current.status === "done" && pref?.hidden === true;
      } finally { authority.close(); }
    }, "explicitly retried success automatically folds without result acknowledgment");
    const beforeRetryAcknowledgment = new SqliteAuthorityStore(database, { readonly: true });
    try {
      const current = await beforeRetryAcknowledgment.getWorkItem("smoke-owner", retryFixture.item.id);
      assert.equal(current.acknowledged_run_id, undefined);
      assert.equal(current.current_run_id, retryState.current.id);
      assert.equal((await beforeRetryAcknowledgment.getWorkRun("smoke-owner", retryState.current.id)).status, "completed");
      assert.equal((await beforeRetryAcknowledgment.getWorkRun("smoke-owner", retryState.current.id)).completion_policy_version, 1);
    } finally { beforeRetryAcknowledgment.close(); }
    await waitFor(() => evaluate(`!document.querySelector(${JSON.stringify(startReviewedFailure)})
      && !document.querySelector(${JSON.stringify(retriedResultAcknowledgment)})`),
      "automatically completed retry removes obsolete renderer actions");
    const afterRetryAcknowledgment = new SqliteAuthorityStore(database, { readonly: true });
    try {
      const current = await afterRetryAcknowledgment.getWorkItem("smoke-owner", retryFixture.item.id);
      assert.equal(current.current_run_id, retryState.current.id);
      assert.equal(current.acknowledged_run_id, undefined);
      assert.equal((await afterRetryAcknowledgment.getWorkRun("smoke-owner", retryFixture.run.id)).status, "failed");
      assert.equal((await afterRetryAcknowledgment.getWorkRun("smoke-owner", retryState.current.id)).status, "completed");
      assert.equal((await afterRetryAcknowledgment.listWorkRuns("smoke-owner", retryFixture.item.id)).length, 2);
      assert.equal(await afterRetryAcknowledgment.getWorkDeliveryByItem("smoke-owner", retryFixture.item.id), null);
      assert.deepEqual(await afterRetryAcknowledgment.listCancellationJobs("smoke-owner"), []);
    } finally { afterRetryAcknowledgment.close(); }
    console.log("PASS: real API manual retry freezes automatic policy v1; successful no-write-back execution folds without human result acknowledgment");
    assert.equal((await api(`/v1/me/inbox/${retryFixture.event.id}`)).attention, "quiet");
    const sender = await api("/v1/me/connectors", {
      connector_type: "lifecycle-smoke-sender",
      config: { base_url: `http://127.0.0.1:${ownedExecutor.address().port}` },
    });
    const automaticallyCompleted = [{
      event: retryFixture.event, marker: retryFixture.marker, runId: retryState.current.id,
    }];
    for (const resolution of ["retry", "sent", "not_sent"]) {
      const status = `write_back_${resolution}`;
      const destination = `${status}-results`;
      deliveryModes.set(destination, resolution);
      executionStates.set(`lifecycle-smoke:${status}`, { status: "running" });
      const [fixture] = await seedLifecycleWork(installedExecutor.id, [status], sender.id, 1);
      await click(".list-views button:nth-child(1)");
      await waitFor(async () => (await api("/v1/me/prefs")).inbox_list === "shown",
        `${fixture.marker} shown-list preference saved before reload`);
      await reloadRenderer();
      await click('nav button[aria-label="Inbox"]');
      await waitFor(() => evaluate('Boolean(document.querySelector(".list-views button"))'), "delivery inbox tabs");
      await click(".list-views button:nth-child(1)");
      const findRow = `[...document.querySelectorAll(".item")].find(row => row.textContent.includes(${JSON.stringify(fixture.marker)}))`;
      await waitFor(() => evaluate(`Boolean(${findRow})`), `${fixture.marker} shown while running`).catch(async (error) => {
        console.error("Delivery inbox diagnostics", await api(`/v1/me/inbox/${fixture.event.id}`),
          await evaluate(`({
            tabs: [...document.querySelectorAll(".list-views button")].map(node => ({
              text: node.textContent, selected: node.getAttribute("aria-selected")
            })),
            rows: [...document.querySelectorAll(".item")].map(node => node.textContent),
            alerts: [...document.querySelectorAll("[role=alert]")].map(node => node.textContent)
          })`));
        throw error;
      });
      await evaluate(`${findRow}.click()`);
      const readState = async () => {
        const authority = new SqliteAuthorityStore(database, { readonly: true });
        try {
          return {
            item: await authority.getWorkItem("smoke-owner", fixture.item.id),
            run: await authority.getWorkRun("smoke-owner", fixture.run.id),
            delivery: await authority.getWorkDeliveryByItem("smoke-owner", fixture.item.id),
            pref: await authority.getConversationPref("smoke-owner", fixture.event.thread_id),
            destinationPref: await authority.getConversationPref("smoke-owner", `lifecycle-smoke:${destination}`),
            disposition: await authority.getDisposition(fixture.event.id),
          };
        } finally { authority.close(); }
      };
      await waitFor(async () => (await readState()).pref?.last_read_external_id === fixture.event.external_id,
        `${fixture.marker} read before completion`);
      executionStates.set(fixture.run.external_run_id, {
        status: "completed", result: { summary: `${fixture.marker}: ready to send.` },
      });
      const retryButton = `.thread-actions button[title="Send the result back again"]`;
      const sentButton = `.thread-actions button[title="Confirm it was sent"]`;
      const notSentButton = `.thread-actions button[title="Confirm it was not sent"]`;
      const recoveryButton = resolution === "retry" ? retryButton
        : resolution === "sent" ? sentButton : notSentButton;
      await waitFor(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(recoveryButton)}))`),
        `${fixture.marker} delivery recovery action`);
      const before = await readState();
      assert.equal(before.item.acknowledged_run_id, undefined);
      assert.equal(before.pref.hidden ?? false, false);
      assert.equal(before.disposition.disposition, "current_work");
      assert.equal(before.delivery.status, resolution === "retry" ? "write_back" : "uncertain");
      assert.equal(before.delivery.write_back, resolution === "retry" ? "failed" : "pending");
      assert.equal((await api(`/v1/me/inbox/${fixture.event.id}`)).attention, "waiting_you");
      assert.equal(await evaluate(`Boolean(document.querySelector(${JSON.stringify(acknowledgeButton)}))`), false);
      if (resolution !== "retry") {
        assert.equal(await evaluate(`Boolean(document.querySelector(${JSON.stringify(retryButton)}))`), false);
      }
      deliveryModes.set(destination, "accept");
      await click(recoveryButton);
      await waitFor(async () => {
        const state = await readState();
        return state.delivery.status === "acked" && state.pref?.hidden === true;
      }, `${fixture.marker} delivery settlement atomically folds the source`);
      const settled = await readState();
      assert.equal(settled.delivery.id, before.delivery.id);
      assert.equal(settled.delivery.run_id, fixture.run.id);
      assert.equal(settled.delivery.status, "acked");
      assert.equal(settled.delivery.write_back, "sent");
      assert.equal(settled.item.acknowledged_run_id, undefined);
      assert.equal(settled.pref.hidden, true);
      if (resolution === "sent") assert.equal(settled.delivery.channel_receipt, undefined);
      else assert.equal(settled.delivery.channel_receipt.accepted, true);
      const after = await readState();
      assert.deepEqual(after.run, before.run);
      assert.deepEqual(after.item, before.item);
      assert.equal(after.item.acknowledged_run_id, undefined);
      assert.equal((await api(`/v1/me/inbox/${fixture.event.id}`)).work.auto_completed, true);
      assert.equal(after.pref.hidden, true);
      assert.equal(after.pref.hidden_reason, "policy");
      assert.equal(after.disposition.disposition, "outside_current_work");
      assert.equal(after.destinationPref?.hidden ?? false, false);
      const requests = deliveryRequests.filter((input) => input.target.scope_id === destination);
      assert.equal(requests.length, resolution === "sent" ? 1 : 2);
      assert.ok(requests.every((input) => input.idempotency_key === before.delivery.idempotency_key));
      assert.equal(deliveredResults.filter((input) => input.target.scope_id === destination).length, 1);
      await waitFor(() => evaluate(`!document.querySelector(${JSON.stringify(recoveryButton)})
        && !document.querySelector(${JSON.stringify(acknowledgeButton)})`),
        `${fixture.marker} automatic completion removes obsolete recovery actions`);
      await click(".list-views button:nth-child(2)");
      await waitFor(() => evaluate(`Boolean(${findRow})`), `${fixture.marker} on hidden list`);
      await evaluate(`${findRow}.click()`);
      await waitFor(() => evaluate(`document.querySelector(".thread-pane")?.textContent.includes(${JSON.stringify(fixture.marker)})`),
        `${fixture.marker} reviewed result can be reopened`);
      assert.equal(await evaluate(`Boolean(document.querySelector(${JSON.stringify(acknowledgeButton)}))`), false);
      automaticallyCompleted.push({ event: fixture.event, marker: fixture.marker, runId: fixture.run.id });
      console.log(`PASS: Electron required write-back ${resolution} settles the original delivery and automatically folds without human result acknowledgment`);
    }
    console.log("PASS: real Electron delivery retry and sent/not-sent reconciliation automatically fold only the source; completed results remain available on the hidden list");
    executionStates.set("lifecycle-smoke:keep_visible", { status: "running" });
    const [kept] = await seedLifecycleWork(installedExecutor.id, ["keep_visible"], undefined, 1, false);
    await click(".list-views button:nth-child(1)");
    await waitFor(async () => (await api("/v1/me/prefs")).inbox_list === "shown",
      "keep-visible shown-list preference saved");
    await reloadRenderer();
    await click('nav button[aria-label="Inbox"]');
    const keptRow = `[...document.querySelectorAll(".item")].find(row => row.textContent.includes(${JSON.stringify(kept.marker)}))`;
    await waitFor(() => evaluate(`Boolean(${keptRow})`), "keep-visible running task");
    await evaluate(`${keptRow}.click()`);
    await waitFor(async () => {
      const authority = new SqliteAuthorityStore(database, { readonly: true });
      try {
        return (await authority.getConversationPref("smoke-owner", kept.event.thread_id))
          ?.last_read_external_id === kept.event.external_id;
      } finally { authority.close(); }
    }, "keep-visible source read before completion");
    executionStates.set(kept.run.external_run_id, {
      status: "completed", result: { summary: `${kept.marker}: completed without hiding.` },
    });
    await waitFor(async () => (await api(`/v1/me/inbox/${kept.event.id}`)).work?.auto_completed === true,
      "keep-visible automatic completion");
    const keptSource = await api(`/v1/me/inbox/${kept.event.id}`);
    assert.equal(keptSource.hidden, false);
    assert.equal(keptSource.attention, "quiet");
    await waitFor(() => evaluate(`Boolean(${keptRow}) && !document.querySelector(${JSON.stringify(acknowledgeButton)})`),
      "completed result stays on shown list without a confirmation action");
    automaticallyCompleted.push({ event: kept.event, marker: kept.marker, runId: kept.run.id, hidden: false });
    console.log("PASS: hide-on-success opt-out automatically completes but stays quiet and available on the shown list");
    await click(".list-views button:nth-child(2)");
    await waitFor(async () => (await api("/v1/me/prefs")).inbox_list === "hidden",
      "hidden-list preference saved before clean restart");
    const requestsBeforeRestart = deliveryRequests.length;
    const executionsBeforeRestart = manualRetryRequests.length;
    const beforeRestart = new SqliteAuthorityStore(database, { readonly: true });
    try {
      for (const fixture of automaticallyCompleted) {
        fixture.run = await beforeRestart.getWorkRun("smoke-owner", fixture.runId);
        fixture.disposition = await beforeRestart.getDisposition(fixture.event.id);
        fixture.delivery = await beforeRestart.getWorkDeliveryByItem("smoke-owner", fixture.run.work_item_id);
      }
    } finally { beforeRestart.close(); }
    const previousPid = child.pid;
    await command("Runtime.evaluate", { expression: "void window.regenic.quitApp()" });
    const quitResult = await Promise.race([
      exited,
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error("Automatic completion restart quit timed out")), 10_000);
        exited.finally(() => clearTimeout(timer));
      }),
    ]);
    assert.deepEqual(quitResult, { code: 0, signal: null });
    assert.equal(existsSync(join(data, "regenic.store.lock")), false);
    ws.close();
    launchElectron();
    await connectRenderer();
    await waitFor(async () => (await api(`/v1/me/inbox/${retryFixture.event.id}`)).work?.auto_completed,
      "automatic completion restored by the restarted desktop API");
    assert.notEqual(child.pid, previousPid);
    assert.equal(JSON.parse(readFileSync(join(data, "regenic.store.lock"), "utf8")).pid, child.pid);
    await click('nav button[aria-label="Inbox"]');
    await waitFor(() => evaluate('Boolean(document.querySelector(".list-views button:nth-child(2)"))'),
      "automatic completion hidden-list tabs after clean restart");
    await click(".list-views button:nth-child(2)");
    for (const fixture of automaticallyCompleted) {
      const source = await api(`/v1/me/inbox/${fixture.event.id}`);
      assert.equal(source.hidden, fixture.hidden ?? true);
      assert.equal(source.work.run_id, fixture.runId);
      assert.equal(source.work.auto_completed, true);
      if (source.work.acknowledged_run_id !== undefined) {
        assert.equal(source.work.acknowledged_run_id, fixture.runId,
          "Reading a restored result may acknowledge only its exact current run");
      }
      const restored = new SqliteAuthorityStore(database, { readonly: true });
      try {
        assert.deepEqual(await restored.getWorkRun("smoke-owner", fixture.runId), fixture.run);
        assert.deepEqual(await restored.getDisposition(fixture.event.id), fixture.disposition);
        assert.deepEqual(await restored.getWorkDeliveryByItem("smoke-owner", fixture.run.work_item_id), fixture.delivery);
      } finally { restored.close(); }
      assert.equal(source.attention, "quiet");
      await click(`.list-views button:nth-child(${fixture.hidden === false ? 1 : 2})`);
      const row = `[...document.querySelectorAll(".item")].find(row => row.textContent.includes(${JSON.stringify(fixture.marker)}))`;
      await waitFor(() => evaluate(`Boolean(${row})`), `${fixture.marker} restored on hidden list`);
      await evaluate(`${row}.click()`);
      await waitFor(() => evaluate(`document.querySelector(".thread-pane")?.textContent.includes(${JSON.stringify(fixture.marker)})`),
        `${fixture.marker} restored result pane`);
      assert.equal(await evaluate(`Boolean(document.querySelector(${JSON.stringify(acknowledgeButton)}))`), false);
    }
    assert.equal(deliveryRequests.length, requestsBeforeRestart, "Restart must not resend completed deliveries");
    assert.equal(manualRetryRequests.length, executionsBeforeRestart, "Restart must not rerun completed work");
    console.log("PASS: clean same-profile Electron restart preserves automatic folding, exact runs and quiet result projection without resending or rerunning");
    assert.equal(unexpectedExecution.length, 0, unexpectedExecution.join("\n"));
  } catch (error) {
    process.exitCode = 1;
    console.error("Electron semantic smoke failed", error);
    console.error(stderr);
    throw error;
  } finally {
    killCrashedKernel();
    if (ws?.readyState === WebSocket.OPEN) {
      await command("Runtime.evaluate", { expression: "window.regenic.quitApp()" }).catch(() => undefined);
    }
    let exitTimer;
    const result = await Promise.race([exited, new Promise((resolve) => {
      exitTimer = setTimeout(() => resolve(null), 10_000);
    })]).finally(() => clearTimeout(exitTimer));
    ws?.close();
    model.closeAllConnections();
    await new Promise((resolve) => model.close(resolve));
    if (ownedExecutor?.listening) {
      ownedExecutor.closeAllConnections();
      await new Promise((resolve) => ownedExecutor.close(resolve));
    }
    if (!result) {
      await ownedElectron.stop();
    }
    cleanExit = result?.code === 0 && !existsSync(join(data, "regenic.store.lock"));
    if (!cleanExit) {
      console.error({ finalExit: result, lockPresent: existsSync(join(data, "regenic.store.lock")) });
    }
    rmSync(root, { recursive: true, force: true });
    if (!cleanExit && !process.exitCode) {
      throw new Error(`Electron did not quit cleanly; the isolated fixture was removed. ${JSON.stringify({ result })}`);
    }
  }
  assert.ok(cleanExit);
  console.log("PASS: clean Electron quit and store-lock release; isolated fixture removed");
}

void runWithFailureCleanup(main, async () => {
  ownedSocket?.close();
  await ownedElectron?.stop();
  killCrashedKernel();
  if (ownedModel?.listening) {
    ownedModel.closeAllConnections();
    await new Promise((resolve) => ownedModel.close(resolve));
  }
  if (ownedExecutor?.listening) {
    ownedExecutor.closeAllConnections();
    await new Promise((resolve) => ownedExecutor.close(resolve));
  }
  rmSync(root, { recursive: true, force: true });
});
