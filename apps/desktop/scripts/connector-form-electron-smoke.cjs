const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join, resolve } = require("node:path");
const { observeChild } = require("./smoke-process.cjs");

const desktop = resolve(__dirname, "..");

async function rendererSmoke() {
  const { app, BrowserWindow } = require("electron");
  app.setPath("userData", process.env.REGENIC_SMOKE_PROFILE);
  await app.whenReady();
  const window = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true } });
  const evaluate = (code) => window.webContents.executeJavaScript(code);
  const waitFor = async (code) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate(code)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.fail(`Connector form did not settle: ${code}`);
  };
  const search = (query) => evaluate(`(() => {
    const input = document.querySelector('input[type="search"]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(query)});
    input.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  const more = () => evaluate(`document.querySelector(".check-options > button").click()`);
  try {
    await window.loadURL(process.env.REGENIC_SMOKE_URL);
    await waitFor('document.querySelector(".check-list")?.textContent.includes("a-first")');
    await more();
    await waitFor('document.querySelector(".check-list").textContent.includes("a-second")');
    assert.equal(await evaluate('document.querySelectorAll(".check-list li").length'), 3,
      "Overlapping pages must not duplicate options or lose the saved selection");
    await more();
    await waitFor('window.__requests.some(request => request.cursor === "100")');
    await evaluate('document.querySelector("#dependency").click()');
    await waitFor('document.querySelector(".check-list").textContent.includes("b-first")');
    await new Promise((resolve) => setTimeout(resolve, 650));
    assert.equal(await evaluate('window.__requests.find(request => request.values.mode === "b").cursor'), undefined,
      "Changing a dependency must reset the cursor before fetching");
    assert.doesNotMatch(await evaluate('document.querySelector(".check-list").textContent'), /a-second|a-late/,
      "A delayed page from an old dependency must not append to the new result");
    assert.match(await evaluate('document.querySelector(".check-list").textContent'), /Saved title/,
      "Selected titles must survive dependency changes");
    await search("x");
    await search("xy");
    await waitFor('document.querySelector(".check-list").textContent.includes("b-xy")');
    assert.equal(await evaluate('window.__requests.some(request => request.query === "x")'), false,
      "Search requests must be debounced");
    await search("slow");
    await waitFor('window.__requests.some(request => request.query === "slow")');
    await search("fast");
    await waitFor('document.querySelector(".check-list").textContent.includes("b-fast")');
    await new Promise((resolve) => setTimeout(resolve, 650));
    assert.doesNotMatch(await evaluate('document.querySelector(".check-list").textContent'), /b-slow/,
      "Late search responses must not replace current results");
    await search("error");
    await waitFor('Boolean(document.querySelector(".check-options [role=alert] button"))');
    await evaluate('document.querySelector(".check-options [role=alert] button").click()');
    await waitFor('document.querySelector(".check-list").textContent.includes("b-error")');
    assert.equal(await evaluate('window.__requests.filter(request => request.query === "error").length'), 2,
      "Retry must load a new first page");
    assert.equal(await evaluate('document.querySelector("#fixture").checkValidity()'), true,
      "Numeric fields must accept fractional values permitted by Core");
    console.log("Connector form dependency, pagination, debounce, cancellation and retry smoke passed");
  } finally {
    window.destroy();
    app.quit();
  }
}

async function launchSmoke() {
  const { createServer } = await import("vite");
  const { default: react } = await import("@vitejs/plugin-react");
  const profile = mkdtempSync(join(tmpdir(), "regenic-connector-form-"));
  const entry = "/__connector-form-smoke.tsx";
  const fixture = `
    import React, { useCallback, useState } from "react";
    import { createRoot } from "react-dom/client";
    import { ConnectorFormFields } from "/src/ConnectorFormFields";
    window.__requests = [];
    window.fetch = async (input, init) => {
      if (new URL(String(input), location.href).pathname !== "/v1/me/engine/catalog-options")
        throw new Error("Unexpected connector form request");
      const request = JSON.parse(init.body);
      window.__requests.push(request);
      const mode = request.values.mode;
      if (request.cursor === "100" || request.query === "slow")
        await new Promise(resolve => setTimeout(resolve, 600));
      if (request.query === "error" && window.__requests.filter(item => item.query === "error").length === 1)
        return new Response(JSON.stringify({ message: "Fixture failed" }), { status: 502 });
      const ids = request.query ? [mode + "-" + request.query]
        : request.cursor === "100" ? [mode + "-late"]
        : request.cursor ? [mode + "-first", mode + "-second"] : [mode + "-first"];
      return new Response(JSON.stringify({
        options: ids.map(value => ({ value, label: value })),
        next_cursor: request.query || request.cursor === "100" ? undefined : request.cursor ? "100" : "50"
      }), { headers: { "content-type": "application/json" } });
    };
    function Fixture() {
      const [values, setValues] = useState({ mode: "a", ids: ["saved"], limit: 0.5 });
      const [options, setOptions] = useState([{ value: "saved", label: "Saved title", title: "Saved title" }]);
      const remember = useCallback((key, page) => setOptions(current =>
        [...new Map([...current, ...page].map(option => [option.value, option])).values()]), []);
      return <form id="fixture">
        <button id="dependency" type="button" onClick={() => setValues(current => ({ ...current, mode: "b" }))}>
          Change dependency
        </button>
        <ConnectorFormFields connectorType="fixture" fields={[
          { key: "ids", label: "IDs", type: "string_array", required: true, dynamic_options: true,
            options_depends_on: ["mode"], options },
          { key: "limit", label: "Limit", type: "number", required: true, min: 0, max: 1 }
        ]} values={values} credentials={{}} busy={false} loading={false} optionsEnabled={true}
          onChange={(key, value) => setValues(current => ({ ...current, [key]: value }))}
          onOptions={remember} />
      </form>;
    }
    createRoot(document.getElementById("root")).render(<React.StrictMode><Fixture /></React.StrictMode>);
  `;
  const server = await createServer({
    configFile: false,
    root: join(desktop, "src/renderer"),
    cacheDir: join(profile, "vite-cache"),
    optimizeDeps: { include: ["@regenic/connector-contract/form"] },
    server: { host: "127.0.0.1", port: 0 },
    plugins: [{
      name: "connector-form-smoke",
      resolveId(id) { if (id === entry) return entry; },
      load(id) { if (id === entry) return fixture; },
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          if (request.url !== "/__connector-form-smoke.html") return next();
          try {
            response.setHeader("content-type", "text/html");
            response.end(await server.transformIndexHtml(request.url,
              '<!doctype html><html><body><div id="root"></div><script type="module" src="' + entry + '"></script></body></html>'));
          } catch (error) { next(error); }
        });
      },
    }, react()],
  });
  let owned;
  try {
    await server.listen();
    const port = server.httpServer.address().port;
    const url = `http://127.0.0.1:${port}/__connector-form-smoke.html`;
    assert.equal((await fetch(url)).ok, true, "Smoke server must be responsive");
    const env = { ...process.env, REGENIC_SMOKE_URL: url, REGENIC_SMOKE_PROFILE: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    owned = observeChild(spawn(require("electron"), [__filename], { cwd: desktop, env, stdio: "inherit" }));
    let timer;
    const result = await Promise.race([
      owned.exited,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Connector form smoke timed out")), 60_000); }),
    ]).finally(() => clearTimeout(timer));
    assert.equal(result.code, 0, "Electron connector form smoke failed");
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
