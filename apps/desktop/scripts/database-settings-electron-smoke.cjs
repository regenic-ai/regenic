const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { observeChild } = require("./smoke-process.cjs");

const desktop = resolve(__dirname, "..");

async function rendererSmoke() {
  const { app, BrowserWindow, ipcMain } = require("electron");
  app.setPath("userData", process.env.REGENIC_SMOKE_PROFILE);
  await app.whenReady();
  let saved = { driver: "sqlite", canChange: true, hasSavedConnection: false };
  let fail = false;
  const applied = [];
  ipcMain.handle("regenic:get-database-settings", () => ({ ok: true, value: saved }));
  ipcMain.handle("regenic:test-database-settings", () => ({ ok: true }));
  ipcMain.handle("regenic:set-database-settings", (_event, input) => {
    applied.push(input);
    if (fail) return { ok: false, error: "database.applyFailed" };
    saved = {
      driver: input.driver, canChange: true, hasSavedConnection: true,
      connectionLabel: "localhost:5432/work",
    };
    return { ok: true, value: saved };
  });
  const window = new BrowserWindow({
    show: false, width: 900, height: 740, webPreferences: {
      contextIsolation: true, sandbox: true, preload: join(desktop, "out/preload/index.cjs"),
    },
  });
  const evaluate = (code) => window.webContents.executeJavaScript(code);
  const waitFor = async (code) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate(code)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const diagnostic = await evaluate(`({
      focused: document.hasFocus(),
      active: document.activeElement?.outerHTML.slice(0, 300),
      tooltip: document.querySelector("[role=tooltip]")?.textContent,
    })`);
    assert.fail(`Database settings did not settle: ${code}\n${JSON.stringify(diagnostic)}`);
  };
  const click = (text) => evaluate(`Array.from(document.querySelectorAll("button"))
    .find(button => button.textContent.trim() === ${JSON.stringify(text)}).click()`);
  const moveMouse = async (selector) => {
    const point = await evaluate(`(() => {
      const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
      return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
    })()`);
    window.webContents.sendInputEvent({ type: "mouseMove", ...point });
  };
  const escape = () => {
    window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
  };
  const resize = async (width, height) => {
    await evaluate(`window.__resized = false;
      window.addEventListener("resize", () => { window.__resized = true; }, { once: true })`);
    window.setSize(width, height);
    await waitFor("window.__resized");
  };
  try {
    await window.loadURL(process.env.REGENIC_SMOKE_URL);
    window.webContents.focus();
    await waitFor('document.querySelector(".settings-current")?.textContent.includes("SQLite")');
    await waitFor('Boolean(document.querySelector("input[name=sync-speed]"))');
    assert.equal(await evaluate('Boolean(document.querySelector("[role=tooltip]"))'), false,
      "Descriptions should not be visible before interaction");
    await moveMouse('#settings-database .card-head .info-tip-trigger');
    await waitFor('Boolean(document.querySelector("[role=tooltip]"))');
    await moveMouse('[role=tooltip]');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(await evaluate('Boolean(document.querySelector("[role=tooltip]"))'), true,
      "The tooltip must remain readable when hovered");
    window.webContents.sendInputEvent({ type: "mouseMove", x: 1, y: 1 });
    await waitFor('!document.querySelector("[role=tooltip]")');
    await evaluate('document.querySelector("button[aria-label=\'About PostgreSQL\']").focus()');
    await waitFor('document.querySelector("[role=tooltip]")?.textContent.includes("You manage")');
    assert.equal(await evaluate('document.querySelector("[role=radio][aria-checked=true]").textContent.trim()'),
      "SQLite · Recommended", "Reading an option's help must not select it");
    escape();
    await waitFor('!document.querySelector("[role=tooltip]")');
    await click("PostgreSQL");
    assert.equal(applied.length, 0);
    await evaluate('document.querySelector("button[aria-label=\'About PostgreSQL\']").click()');
    await waitFor('Boolean(document.querySelector("[role=tooltip]"))');
    if (process.env.REGENIC_SMOKE_SCREENSHOT) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      writeFileSync(process.env.REGENIC_SMOKE_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
    }
    escape();
    await waitFor('!document.querySelector("[role=tooltip]")');
    await resize(380, 740);
    await evaluate(`(() => {
      const button = document.querySelector("button[aria-label='About PostgreSQL']");
      button.parentElement.style.cssText = "position:fixed;right:12px;bottom:12px;top:auto;transform:none";
      button.blur();
      button.focus();
    })()`);
    await waitFor('Boolean(document.querySelector("[role=tooltip]"))');
    assert.equal(await evaluate(`(() => {
      const popup = document.querySelector("[role=tooltip]").getBoundingClientRect();
      const anchor = document.querySelector("button[aria-label='About PostgreSQL']").getBoundingClientRect();
      return popup.left >= 0 && popup.right <= innerWidth && popup.top >= 0 &&
        popup.bottom <= anchor.top && document.documentElement.scrollWidth <= innerWidth;
    })()`), true, "Help must fit narrow viewports and flip above bottom-edge controls");
    escape();
    await evaluate(`document.querySelector("button[aria-label='About PostgreSQL']").parentElement.removeAttribute("style")`);
    await resize(900, 740);
    await evaluate(`(() => {
      const input = document.querySelector('input[type="password"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")
        .set.call(input, "postgresql://user:fixture@localhost/work");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    await waitFor('!Array.from(document.querySelectorAll("button")).find(b => b.textContent === "Test connection").disabled');
    await click("Test connection");
    await waitFor('document.body.textContent.includes("Connection successful")');
    assert.equal(applied.length, 0, "Testing must not change the selection");
    await click("Apply");
    await waitFor('Boolean(document.querySelector("[role=alert] strong"))');
    assert.match(await evaluate('document.querySelector("[role=alert] p").textContent'),
      /will not be moved or deleted/, "Switching consequences must stay visible without a tooltip");
    assert.equal(applied.length, 0, "Apply must require confirmation");
    await click("Cancel");
    assert.equal(applied.length, 0);
    await click("Apply");
    await click("Switch database");
    await waitFor('document.querySelector(".settings-current").textContent.includes("PostgreSQL")');
    assert.equal(applied[0].confirmed, true);
    assert.equal(await evaluate("document.querySelector('input[type=password]').value"), "",
      "Credentials must leave the input after saving");
    assert.equal(await evaluate("window.__refreshes"), 1);

    fail = true;
    await click("SQLite · Recommended");
    await click("Apply");
    await click("Switch database");
    await waitFor('document.querySelector(".action-error")?.textContent.includes("previous database setting was restored")');
    assert.match(await evaluate('document.querySelector(".settings-current").textContent'), /PostgreSQL/,
      "A failed switch must not claim that the requested database is active");

    saved = { ...saved, canChange: false };
    await evaluate("window.__setMode('custom')");
    await waitFor('document.body.textContent.includes("custom engine")');
    assert.equal(await evaluate("Array.from(document.querySelectorAll('[role=radio]')).every(button => button.disabled)"), true);

    await evaluate('document.querySelector(".sync-settings-advanced summary .info-tip-trigger").click()');
    await waitFor('document.querySelector("[role=tooltip]")?.textContent.includes("editing a value")');
    assert.equal(await evaluate('document.querySelector(".sync-settings-advanced").open'), false,
      "Opening help must not toggle advanced controls");
    escape();
    await evaluate('document.querySelector(".sync-settings-advanced summary").click()');
    await evaluate('document.querySelector("#sync-quota_tokens").scrollIntoView({ block: "center" })');
    await new Promise((resolve) => setTimeout(resolve, 150));
    await evaluate('document.querySelector("button[aria-describedby=sync-quota_tokens-hint]").focus()');
    await waitFor('document.querySelector("[role=tooltip]")?.textContent.includes("Default: 60")');
    assert.match(await evaluate('document.querySelector("[role=tooltip]").textContent'), /0–10000/,
      "Ranges and defaults must remain available in field help");
    escape();
    assert.equal(await evaluate(`(() => {
      const input = document.querySelector("#sync-quota_tokens");
      const description = document.getElementById(input.getAttribute("aria-describedby"));
      return description.classList.contains("sr-only") && description.textContent.includes("Default: 60");
    })()`), true, "Numeric controls must retain accessible descriptions when help is closed");
    await evaluate('document.querySelector(".sync-settings-advanced summary").click()');
    await evaluate('document.querySelector("input[name=sync-speed][value=faster]").click()');
    await click("Save preferences");
    await waitFor('document.querySelector("#settings-sync .action-ok")?.textContent.includes("saved")');
    assert.equal(await evaluate("window.__syncSaves[0].quota_tokens"), 120,
      "Compact controls must preserve preset saving behavior");
    console.log("Database settings Electron smoke passed");
  } finally {
    window.destroy();
    app.quit();
  }
}

async function launchSmoke() {
  const { createServer } = await import("vite");
  const { default: react } = await import("@vitejs/plugin-react");
  const profile = mkdtempSync(join(tmpdir(), "regenic-database-ui-"));
  const entry = "/__database-smoke.tsx";
  const fixture = `
    import React, { useState } from "react";
    import { createRoot } from "react-dom/client";
    import { DatabaseSettings } from "/src/DatabaseSettings";
    import { SyncSettings } from "/src/SyncSettings";
    import "/src/styles.css";
    window.__refreshes = 0;
    window.__syncSaves = [];
    const defaults = {
      quota_tokens: 60, quota_window_ms: 60000, installation_concurrency: 4,
      live_concurrency: 8, history_concurrency: 4, media_concurrency: 1,
      first_seed_limit: 16, steady_claim_limit: 32, bootstrap_claim_limit: 16,
    };
    const ranges = {
      quota_tokens: [0, 10000], quota_window_ms: [1000, 3600000], installation_concurrency: [1, 16],
      live_concurrency: [1, 64], history_concurrency: [1, 64], media_concurrency: [1, 16],
      first_seed_limit: [0, 64], steady_claim_limit: [1, 128], bootstrap_claim_limit: [1, 128],
    };
    const realFetch = window.fetch;
    window.fetch = async (url, options) => {
      if (!String(url).endsWith("/v1/me/sync-settings")) return realFetch(url, options);
      const settings = options?.method === "POST" ? JSON.parse(options.body).settings : null;
      if (options?.method === "POST") window.__syncSaves.push(settings);
      return new Response(JSON.stringify({ settings: settings ?? defaults, defaults, ranges, customized: settings !== null }),
        { headers: { "content-type": "application/json" } });
    };
    function Fixture() {
      const [mode, setMode] = useState("local");
      window.__setMode = setMode;
      return <main className="page"><div className="settings-sections">
        <DatabaseSettings engineMode={mode}
          onChanged={async () => { window.__refreshes++; }} />
        <SyncSettings />
      </div></main>;
    }
    createRoot(document.getElementById("root")).render(<Fixture />);
  `;
  const server = await createServer({
    configFile: false,
    root: join(desktop, "src/renderer"),
    cacheDir: join(profile, "vite-cache"),
    server: { host: "127.0.0.1", port: 0 },
    plugins: [{
      name: "database-settings-smoke",
      resolveId(id) { if (id === entry) return entry; },
      load(id) { if (id === entry) return fixture; },
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (request.url !== "/__database-smoke.html") return next();
          response.setHeader("content-type", "text/html");
          response.end(await server.transformIndexHtml(request.url,
            '<div id="root"></div><script type="module" src="' + entry + '"></script>'));
        });
      },
    }, react()],
  });
  try {
    await server.listen();
    const child = spawn(require("electron"), [__filename, "--renderer-smoke"], {
      cwd: desktop,
      env: {
        ...process.env,
        REGENIC_SMOKE_PROFILE: profile,
        REGENIC_SMOKE_URL: `${server.resolvedUrls.local[0]}__database-smoke.html`,
      },
      stdio: "inherit",
    });
    const observed = observeChild(child);
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
    try {
      const result = await observed.exited;
      assert.equal(result.code, 0);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await server.close();
    rmSync(profile, { recursive: true, force: true });
  }
}

(process.argv.includes("--renderer-smoke") ? rendererSmoke() : launchSmoke())
  .catch((error) => { console.error(error); process.exit(1); });
