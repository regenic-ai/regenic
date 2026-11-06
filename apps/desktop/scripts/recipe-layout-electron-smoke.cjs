const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { observeChild } = require("./smoke-process.cjs");

const desktop = resolve(__dirname, "..");

async function rendererSmoke() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", process.env.REGENIC_SMOKE_PROFILE);
  await app.whenReady();
  const window = new BrowserWindow({
    width: 1186,
    height: 800,
    useContentSize: true,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  try {
    await window.loadURL(process.env.REGENIC_SMOKE_URL);
    for (let attempt = 0; ; attempt++) {
      if (await window.webContents.executeJavaScript(
        'Boolean(document.querySelector(".recipe-form-foot"))',
      )) break;
      assert.ok(attempt < 100, "Real recipe editor did not render");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await window.webContents.executeJavaScript(`(() => {
      const buttons = [...document.querySelectorAll(".seg button")];
      const keepHere = buttons.find(button => button.textContent.trim() === "Keep here");
      if (!keepHere) throw new Error("Missing local-result option");
      keepHere.click();
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await window.webContents.executeJavaScript(`(() => {
      const row = [...document.querySelectorAll(".recipe-row")]
        .find(row => row.textContent.includes("Send result to"));
      return Boolean(row?.querySelector(".menu-select-btn"));
    })()`), true, "Destination picker must remain reachable when results stay local");
    const setFilters = async (contains, excludes) => {
      await window.webContents.executeJavaScript(`(() => {
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        for (const [label, value] of ${JSON.stringify([
          ["Body contains", contains], ["Body does not contain", excludes],
        ])}) {
          const input = document.querySelector('input[aria-label="' + label + '"]');
          if (!input) throw new Error("Missing filter input: " + label);
          set.call(input, value);
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
      })()`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    };
    await setFilters("APPROVE", "RELEASE");
    assert.match(await window.webContents.executeJavaScript(
      'document.querySelector(".recipe-preview-body").textContent',
    ), /No matching chats/, "Exclusion must update the real editor preview");
    await setFilters("APPROVE", "DRAFT");
    assert.match(await window.webContents.executeJavaScript(
      'document.querySelector(".recipe-preview-body").textContent',
    ), /Filter smoke chat/, "Matching body must appear in the real editor preview");
    await window.webContents.executeJavaScript(
      'document.querySelector(\'input[aria-label="Body contains"]\').scrollIntoView({ block: "start" })',
    );
    writeFileSync(join(process.env.REGENIC_SMOKE_OUTPUT, "filters.png"),
      (await window.webContents.capturePage()).toPNG());
    for (const [width, height] of [[800, 800], [1000, 800], [1099, 800], [1100, 800],
      [1186, 800], [1440, 800], [1920, 800], [1186, 600]]) {
      window.setContentSize(width, height);
      await new Promise((resolve) => setTimeout(resolve, 150));
      const measurement = await window.webContents.executeJavaScript(`(async () => {
        const page = document.querySelector(".page-recipes");
        page.scrollTop = page.scrollHeight;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const card = page.querySelector(".recipe-editor");
        const footer = card.querySelector(".recipe-form-foot");
        const hint = footer.querySelector(".recipe-try-hint");
        const pageBox = page.getBoundingClientRect();
        const cardBox = card.getBoundingClientRect();
        const footerBox = footer.getBoundingClientRect();
        return {
          width: innerWidth, height: innerHeight,
          display: getComputedStyle(page).display,
          gridRows: getComputedStyle(page).gridTemplateRows,
          paddingBottom: getComputedStyle(page).paddingBottom,
          scrollHeight: page.scrollHeight, clientHeight: page.clientHeight,
          gap: pageBox.bottom - cardBox.bottom,
          footerOverflow: footerBox.bottom - cardBox.bottom,
          hintBottom: hint?.getBoundingClientRect().bottom,
          cardBottom: cardBox.bottom, pageBottom: pageBox.bottom,
        };
      })()`);
      console.log(JSON.stringify(measurement));
      const screenshot = await window.webContents.capturePage();
      writeFileSync(join(process.env.REGENIC_SMOKE_OUTPUT, `${width}x${height}.png`),
        screenshot.toPNG());
      assert.ok(Math.abs(measurement.gap - 28) <= 1,
        `Expected 28px gap at ${width}x${height}: ${JSON.stringify(measurement)}`);
      assert.ok(measurement.footerOverflow <= 1,
        `Footer escapes editor at ${width}x${height}`);
      assert.ok(measurement.hintBottom <= measurement.cardBottom,
        `Hint escapes editor at ${width}x${height}`);
    }
    await window.webContents.executeJavaScript(
      'document.querySelector(".recipe-form").requestSubmit()',
    );
    for (let attempt = 0; ; attempt++) {
      const saved = await window.webContents.executeJavaScript(
        'window.__savedRecipe ?? null',
      );
      if (saved) {
        assert.equal(saved.match.text_contains, "APPROVE");
        assert.equal(saved.match.text_excludes, "DRAFT");
        break;
      }
      assert.ok(attempt < 50, "Filtered recipe was not saved");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    for (let attempt = 0; ; attempt++) {
      const edited = await window.webContents.executeJavaScript(`(() => {
        const card = document.querySelector(".recipe-card-hit");
        if (!card) return false;
        card.click();
        return true;
      })()`);
      if (edited) break;
      assert.ok(attempt < 50, "Saved recipe card did not render");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(await window.webContents.executeJavaScript(`[
      document.querySelector('input[aria-label="Body contains"]').value,
      document.querySelector('input[aria-label="Body does not contain"]').value
    ]`), ["APPROVE", "DRAFT"], "Editing must restore saved filters");
    console.log("Recipe filter preview, save and edit smoke passed");
  } finally {
    window.destroy();
    app.quit();
  }
}

async function launchSmoke() {
  const { createServer } = await import("vite");
  const { default: react } = await import("@vitejs/plugin-react");
  const profile = mkdtempSync(join(tmpdir(), "regenic-recipe-layout-"));
  const output = resolve(process.env.REGENIC_SMOKE_OUTPUT ||
    mkdtempSync(join(tmpdir(), "regenic-recipe-screenshots-")));
  mkdirSync(output, { recursive: true });
  const entry = "/__recipe-smoke.tsx";
  const html = '<!doctype html><html><head><meta charset="UTF-8"></head><body>' +
    '<div id="root"></div><script type="module" src="' + entry + '"></script></body></html>';
  const fixture = `
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { RecipesPage } from "/src/RecipesPage";
    import "/src/styles.css";
    const fixtures = {
      "/v1/me/recipes": [],
      "/v1/me/executors": [{
        executor_type: "smoke", label: "Smoke assistant", description: "Layout smoke fixture",
        fields: [
          { key: "skill", label: "Skill", kind: "text", hint: "Optional skill" },
          { key: "prompt", label: "Prompt", kind: "textarea", hint: "Optional instructions" }
        ]
      }]
    };
    window.fetch = async (input, init) => {
      const path = new URL(String(input), location.href).pathname;
      if (path === "/v1/me/recipes" && init?.method === "POST") {
        const recipe = { ...JSON.parse(init.body), id: "smoke-rule", org_id: "local-owner",
          created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
        window.__savedRecipe = recipe;
        fixtures[path] = [recipe];
        return new Response(JSON.stringify(recipe), { headers: { "content-type": "application/json" } });
      }
      if (!(path in fixtures)) throw new Error("Unexpected smoke request: " + path);
      return new Response(JSON.stringify(fixtures[path]), { headers: { "content-type": "application/json" } });
    };
    createRoot(document.getElementById("root")).render(
      <div className="shell">
        <header className="titlebar">Recipe layout smoke</header>
        <nav className="rail" />
        <div className="workspace"><RecipesPage sources={[]} conversations={[{
          id: "smoke:room", label: "Filter smoke chat", source: "smoke",
          record_class: "utterance", thread_facet: "chat", body_text: "approve release"
        }]} seed={{ thread_id: "smoke:room", title: "Filter smoke chat" }} /></div>
      </div>
    );
  `;
  const server = await createServer({
    configFile: false,
    root: join(desktop, "src/renderer"),
    cacheDir: join(profile, "vite-cache"),
    server: { host: "127.0.0.1", port: 0 },
    plugins: [{
      name: "recipe-smoke-fixture",
      resolveId(id) { if (id === entry) return entry; },
      load(id) { if (id === entry) return fixture; },
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (request.url !== "/__recipe-smoke.html") return next();
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
      REGENIC_SMOKE_URL: `http://127.0.0.1:${port}/__recipe-smoke.html`,
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
        timer = setTimeout(() => reject(new Error("Electron layout smoke timed out")), 60_000);
      }),
    ]).finally(() => clearTimeout(timer));
    assert.equal(result.code, 0, "Electron layout smoke failed");
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
