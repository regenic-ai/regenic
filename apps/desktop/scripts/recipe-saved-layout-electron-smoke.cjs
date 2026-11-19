const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { observeChild } = require("./smoke-process.cjs");

const desktop = resolve(__dirname, "..");
// The desktop window enforces minWidth 900.
const SIZES = [[1920, 900], [1440, 900], [1350, 800], [1186, 800], [1100, 800], [1024, 800], [900, 600]];

async function rendererSmoke() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", process.env.REGENIC_SMOKE_PROFILE);
  await app.whenReady();
  const window = new BrowserWindow({
    width: 1186,
    height: 800,
    show: false,
    useContentSize: true,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  window.webContents.on("console-message", (event) => {
    if (event.level === "error") console.error("Recipe renderer:", event.message);
  });
  try {
    for (const locale of ["zh", "en"]) {
      await window.loadURL(`${process.env.REGENIC_SMOKE_URL}?locale=${locale}`);
      for (let attempt = 0; ; attempt++) {
        if (await window.webContents.executeJavaScript(
          'document.querySelectorAll(".recipe-card").length === 2 && !document.querySelector(".recipe-editor")',
        )) break;
        assert.ok(attempt < 100, `Saved automations did not render (${locale})`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      for (const [width, height] of SIZES) {
        window.setContentSize(width, height);
        await new Promise((resolve) => setTimeout(resolve, 150));
        const layout = await window.webContents.executeJavaScript(`(async () => {
          document.querySelector(".page-recipes").scrollTop = 0;
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const problems = [];
          const heading = document.querySelector(".recipe-saved > .card-head h2");
          if (heading.getClientRects().length > 1 || heading.scrollWidth > heading.clientWidth + 1) {
            problems.push("list heading wraps or is clipped");
          }
          const headActions = [...document.querySelectorAll(".recipe-head-actions button")]
            .map((button) => button.getBoundingClientRect());
          if (headActions.some((box) => Math.abs(box.top - headActions[0].top) > 1)) {
            problems.push("list export/import actions are stacked");
          }
          for (const card of document.querySelectorAll(".recipe-card")) {
            const name = card.querySelector(".recipe-card-title strong").textContent;
            const hit = card.querySelector(".recipe-card-hit").getBoundingClientRect();
            const actions = card.querySelector(".install-actions").getBoundingClientRect();
            const separated = actions.top >= hit.bottom - 1 || actions.left >= hit.right - 1;
            if (!separated) problems.push(name + ": actions overlap the summary");
            if (hit.width < 220) problems.push(name + ": summary squeezed to " + Math.round(hit.width) + "px");
            const summary = card.querySelector(".recipe-card-summary");
            if (!summary) problems.push(name + ": missing one-line summary");
            else if (summary.getClientRects().length > 1) problems.push(name + ": summary wraps");
            if (card.querySelector(".recipe-chain, .recipe-run-history, .recipe-card-how")) {
              problems.push(name + ": list still expands the chain, instruction, or run history");
            }
            const rowHeight = Math.round(card.getBoundingClientRect().height);
            if (rowHeight > 84) problems.push(name + ": row is " + rowHeight + "px tall");
            for (const button of card.querySelectorAll(".install-actions button")) {
              if (button.scrollWidth > button.clientWidth + 1) {
                problems.push(name + ": action '" + button.textContent.trim() + "' is clipped");
              }
            }
          }
          for (const seg of document.querySelectorAll(".recipe-form .seg")) {
            const body = seg.closest(".recipe-row-body").getBoundingClientRect();
            const track = seg.getBoundingClientRect();
            if (track.right > body.right + 1) problems.push("segmented control escapes its row");
            const buttons = [...seg.querySelectorAll("button")];
            for (const button of buttons) {
              const box = button.getBoundingClientRect();
              if (button.scrollWidth > button.clientWidth + 1 || box.right > track.right + 1) {
                problems.push("option '" + button.textContent.trim() + "' is clipped");
              }
            }
            for (let i = 1; i < buttons.length; i++) {
              const a = buttons[i - 1].getBoundingClientRect();
              const b = buttons[i].getBoundingClientRect();
              const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
              const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
              if (overlapX > 1 && overlapY > 1) problems.push("options overlap: " + buttons[i].textContent.trim());
            }
          }
          if (document.querySelector(".recipe-editor")) problems.push("editor is open beside the list");
          return problems;
        })()`);
        writeFileSync(join(process.env.REGENIC_SMOKE_OUTPUT, `saved-${locale}-${width}x${height}.png`),
          (await window.webContents.capturePage()).toPNG());
        assert.deepEqual(layout, [], `Saved automation layout at ${locale} ${width}x${height}`);
      }
      if (locale === "zh") {
        window.setContentSize(1350, 800);
        await window.webContents.executeJavaScript('document.querySelector(".recipe-card-hit").click()');
        for (let attempt = 0; ; attempt++) {
          if (await window.webContents.executeJavaScript(
            'Boolean(document.querySelector(".recipe-editor")) && !document.querySelector(".recipe-saved")',
          )) break;
          assert.ok(attempt < 50, "Opening an automation did not replace the list");
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        writeFileSync(join(process.env.REGENIC_SMOKE_OUTPUT, "editor-zh-1350.png"),
          (await window.webContents.capturePage()).toPNG());
        await window.webContents.executeJavaScript(`(async () => {
          document.querySelector(".recipe-form-foot").scrollIntoView({ block: "end" });
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        })()`);
        writeFileSync(join(process.env.REGENIC_SMOKE_OUTPUT, "editor-foot-zh-1350.png"),
          (await window.webContents.capturePage()).toPNG());
        await window.webContents.executeJavaScript('document.querySelector(".recipe-back").click()');
        for (let attempt = 0; ; attempt++) {
          if (await window.webContents.executeJavaScript(
            'document.querySelectorAll(".recipe-card").length === 2 && !document.querySelector(".recipe-editor")',
          )) break;
          assert.ok(attempt < 50, "Back did not return to the list");
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
    }
    console.log("Saved automation list and editor controls fit at every width in both locales");
  } finally {
    window.destroy();
    app.quit();
  }
}

async function launchSmoke() {
  const { createServer } = await import("vite");
  const { default: react } = await import("@vitejs/plugin-react");
  const profile = mkdtempSync(join(tmpdir(), "regenic-recipe-saved-layout-"));
  const output = resolve(process.env.REGENIC_SMOKE_OUTPUT ||
    mkdtempSync(join(tmpdir(), "regenic-recipe-saved-screenshots-")));
  mkdirSync(output, { recursive: true });
  const entry = "/__recipe-saved-smoke.tsx";
  const html = '<!doctype html><html><head><meta charset="UTF-8"></head><body>' +
    '<div id="root"></div><script type="module" src="' + entry + '"></script></body></html>';
  const fixture = `
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { LocaleProvider } from "/src/LocaleContext";
    import { RecipesPage } from "/src/RecipesPage";
    import "/src/styles.css";
    const locale = new URLSearchParams(location.search).get("locale") === "zh" ? "zh" : "en";
    window.regenic = {
      getKernelSettings: async () => ({
        mode: "local", customOrigin: location.origin, activeOrigin: location.origin, locale,
      }),
    };
    const now = Date.now();
    const at = (minutes) => new Date(now - minutes * 60_000).toISOString();
    const config = (thread, enabled) => ({
      source: { installations: "all" },
      scope: { kind: "new_messages", match: { thread_id: thread } },
      handler: { kind: "agent", executor_type: "dsh", task: "评估达人项目，缺信息时在群里追问需要补充的字段。" },
      destination: { kind: "reply", thread: "origin", confirm: false, send: true },
      trigger: { kind: "push" },
      hide_on_success: false,
      include_context: true,
      enabled,
    });
    const runs = [
      { status: "completed", at: at(10), thread_id: "feishu:eval", summary: "@李诗婷 还缺这些，补全前先不评估： - 产品 - 国家/地区 - TikTok 是否带货（纯付费 / TTS 带货 / 都要）" },
      { status: "completed", at: at(30), thread_id: "feishu:eval", summary: "@李诗婷 还缺这些，补全前先不评估： - 产品 - 平台 - 国家/地区 - 单个达人预算（USD） - 粉丝 - CPM" },
      { status: "completed", at: at(55), thread_id: "feishu:eval", summary: "已完成评估并发回原群。" },
    ];
    const flows = [
      { id: "eval", org_id: "local-owner", name: "测试项目评估-DSH", config: config("feishu:eval", false),
        last_run: runs[0], recent_runs: runs, created_at: at(600), updated_at: at(10) },
      { id: "long", org_id: "local-owner",
        name: "Weekly creator brief for the regenic growth team with a deliberately long name",
        config: config("feishu:brief", true), created_at: at(900), updated_at: at(120) },
    ];
    window.fetch = async (input) => {
      const path = new URL(String(input), location.href).pathname;
      const json = (value) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
      if (path === "/v1/me/flows") return json(flows);
      if (path === "/v1/me/executors") return json([{
        executor_type: "dsh", label: "DSH", description: "Saved layout fixture", fields: [],
      }]);
      if (path === "/v1/me/inbox") return json({ pinned: [], live: [], active_work: [], has_older: false, next_before: null });
      throw new Error("Unexpected smoke request: " + path);
    };
    const conversations = [
      { id: "feishu:eval", label: "仅 regenic 测试群（达人项目评估）", source: "feishu", can_send: true },
      { id: "feishu:brief", label: "Growth team weekly briefing channel", source: "feishu", can_send: true },
    ];
    createRoot(document.getElementById("root")).render(
      <LocaleProvider>
        <div className="shell" style={{ display: "grid", gridTemplateColumns: "248px minmax(0, 1fr)", height: "100vh" }}>
          <aside className="sidebar" />
          <div className="workspace" style={{ height: "100%", minWidth: 0 }}>
            <RecipesPage
              sources={[{ id: "feishu", label: "Feishu" }]}
              conversations={conversations}
              onOpenThread={() => {}}
            />
          </div>
        </div>
      </LocaleProvider>
    );
  `;
  const server = await createServer({
    configFile: false,
    root: join(desktop, "src/renderer"),
    cacheDir: join(profile, "vite-cache"),
    server: { host: "127.0.0.1", port: 0 },
    plugins: [{
      name: "recipe-saved-smoke-fixture",
      resolveId(id) { if (id === entry) return entry; },
      load(id) { if (id === entry) return fixture; },
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (!request.url?.startsWith("/__recipe-saved-smoke.html")) return next();
          try {
            response.setHeader("content-type", "text/html");
            response.end(await server.transformIndexHtml(request.url, html));
          } catch (error) { next(error); }
        });
      },
    }, react()],
  });
  let owned;
  try {
    await server.listen();
    const port = server.httpServer.address().port;
    const env = {
      ...process.env,
      REGENIC_SMOKE_URL: `http://127.0.0.1:${port}/__recipe-saved-smoke.html`,
      REGENIC_SMOKE_PROFILE: profile,
      REGENIC_SMOKE_OUTPUT: output,
    };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require("electron"), [__filename], {
      cwd: desktop, env, stdio: "inherit",
    });
    owned = observeChild(child);
    let timer;
    const result = await Promise.race([
      owned.exited,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Electron saved layout smoke timed out")), 60_000);
      }),
    ]).finally(() => clearTimeout(timer));
    assert.equal(result.code, 0, "Electron saved layout smoke failed");
    console.log(`Screenshots: ${output}`);
  } finally {
    if (owned) await owned.stop();
    await server.close();
    rmSync(profile, { recursive: true, force: true });
  }
}

(process.versions.electron ? rendererSmoke() : launchSmoke()).catch((error) => {
  console.error(error);
  if (process.versions.electron) require("electron").app.exit(1);
  else process.exitCode = 1;
});
