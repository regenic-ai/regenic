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
    window.webContents.focus();
    await waitFor('Boolean(document.querySelector("#connector-installation-enabled"))');
    assert.equal(await evaluate('Boolean(document.querySelector("[role=tooltip]"))'), false);
    await evaluate('document.querySelector("button[aria-label=\'About Limit\']").focus()');
    await waitFor('document.querySelector("[role=tooltip]")?.textContent.includes("between zero and one")');
    const clicksBeforeHelp = await evaluate("window.__dialogClicks ?? 0");
    await evaluate('document.querySelector("[role=tooltip]").click()');
    assert.equal(await evaluate("window.__dialogClicks ?? 0"), clicksBeforeHelp,
      "Reading a tooltip must not click the containing dialog backdrop");
    assert.equal(await evaluate(`(() => {
      const input = document.querySelector('#fixture input[type="number"]');
      return document.getElementById(input.getAttribute("aria-describedby")).textContent.includes("between zero and one");
    })()`), true, "Field descriptions must remain available to assistive technology");
    await evaluate(`(() => {
      const input = document.querySelector('#fixture input[type="number"]');
      input.focus();
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    })()`);
    await waitFor('!document.querySelector("[role=tooltip]")');
    assert.equal(await evaluate("window.__dialogEscapes ?? 0"), 0,
      "Escape must dismiss help before reaching the dialog");
    assert.equal(await evaluate("window.__formSubmits"), 0, "Reading help must not submit configuration");
    assert.equal(await evaluate(`Array.from(document.querySelectorAll(".connector-kind button"))
      .some(button => button.textContent.trim() === "Disable")`), false,
    "Connector rows must not expose a disable action");
    for (const status of ["enabled", "disabled", "needs_attention"]) {
      assert.equal(await evaluate(`Array.from(document.querySelectorAll("#connector-installation-${status} button"))
        .some(button => button.textContent.trim() === "Uninstall")`), true,
      "Every installation must keep its uninstall action");
    }
    await evaluate(`Array.from(document.querySelectorAll("#connector-installation-disabled button"))
      .find(button => button.textContent.trim() === "Enable").click()`);
    assert.equal(await evaluate('window.__enabledInstallation'), "disabled",
      "Previously disabled installations must remain recoverable");
    await evaluate(`Array.from(document.querySelectorAll("#connector-installation-enabled button"))
      .find(button => button.textContent.trim() === "Uninstall").click()`);
    assert.equal(await evaluate('window.__uninstalledInstallation'), "enabled");
    await waitFor('document.querySelector(".check-list")?.textContent.includes("a-first")');
    await more();
    await waitFor('document.querySelector(".check-list").textContent.includes("a-second")');
    assert.equal(await evaluate('document.querySelector(".check-list").querySelectorAll("li").length'), 3,
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
    assert.equal(await evaluate('document.querySelectorAll(\'input[aria-label="Custom value for Tags"]\').length'), 1,
      "allow_custom multi-select fields must expose a custom-value input");
    const customInput = 'input[aria-label="Custom value for Tags"]';
    const addCustom = async (value, enter = false) => {
      await evaluate(`(() => {
        const input = document.querySelector(${JSON.stringify(customInput)});
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${JSON.stringify(value)});
        input.dispatchEvent(new Event("input", { bubbles: true }));
      })()`);
      await new Promise((resolve) => setTimeout(resolve, 50));
      await evaluate(enter
        ? `document.querySelector(${JSON.stringify(customInput)}).dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }))`
        : 'document.querySelector(\'input[aria-label="Custom value for Tags"]\').parentElement.querySelector("button").click()');
      await new Promise((resolve) => setTimeout(resolve, 50));
    };
    await addCustom(" Team, West ");
    assert.deepEqual(await evaluate('window.__formValues.tags'), ["known", "Team, West"],
      "Adding a custom tag must preserve commas and existing selections");
    await addCustom("Team, West", true);
    assert.deepEqual(await evaluate('window.__formValues.tags'), ["known", "Team, West"],
      "Adding the same tag must not duplicate it");
    await addCustom("  ", true);
    assert.deepEqual(await evaluate('window.__formValues.tags'), ["known", "Team, West"],
      "Blank custom values must not be added");
    await addCustom("Another", true);
    assert.deepEqual(await evaluate('window.__formValues.tags'), ["known", "Team, West", "Another"]);
    assert.equal(await evaluate('window.__formSubmits'), 0, "Enter must not submit the enclosing form");
    await evaluate(`(() => {
      const input = [...document.querySelectorAll('input[name="tags"]')]
        .find(input => input.parentElement.textContent.includes("Team, West"));
      input.click();
    })()`);
    await waitFor('window.__formValues.tags.length === 2');
    assert.deepEqual(await evaluate('window.__formValues.tags'), ["known", "Another"],
      "Custom values must remain removable");
    assert.equal(await evaluate('document.querySelectorAll(\'input[aria-label="Custom value for IDs"]\').length'), 0,
      "Closed option fields must not expose custom input");
    await evaluate(`(() => {
      const input = document.querySelector('input[aria-label="Custom value for Remote"]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "custom,remote");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await evaluate('document.querySelector(\'input[aria-label="Custom value for Remote"]\').parentElement.querySelector("button").click()');
    await waitFor('window.__formValues.remote === "custom,remote"');
    assert.deepEqual(await evaluate('window.__optionUpdates.find(update => update.key === "remote" && update.page[0].value === "custom,remote").page'),
      [{ value: "custom,remote", label: "custom,remote", title: "custom,remote" }],
      "Custom values must populate option metadata for payload labels");
    await evaluate(`(() => {
      [...document.querySelectorAll('input[name="remote"]')]
        .find(input => input.parentElement.textContent.includes("Suggested remote")).click();
    })()`);
    await waitFor('window.__formValues.remote === "suggested-remote"');
    await evaluate(`(() => {
      [...document.querySelectorAll('input[name="tags"]')]
        .find(input => input.parentElement.textContent.trim() === "Known").click();
    })()`);
    await waitFor('!window.__formValues.tags.includes("known")');
    await addCustom("known", true);
    await waitFor('window.__formValues.tags.includes("known")');
    assert.deepEqual(await evaluate('window.__optionUpdates.filter(update => update.key === "tags").at(-1).page'),
      [{ value: "known", label: "Known" }], "Adding a suggestion by value must preserve its label");
    console.log("Connector form pagination, cancellation, retry and custom-value smoke passed");
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
    import { ConnectorKind } from "/src/ConnectorSettings";
    import "/src/styles.css";
    window.__requests = [];
    window.__optionUpdates = [];
    window.__formSubmits = 0;
    window.fetch = async (input, init) => {
      if (new URL(String(input), location.href).pathname !== "/v1/me/engine/catalog-options")
        throw new Error("Unexpected connector form request");
      const request = JSON.parse(init.body);
      if (request.field === "remote") return new Response(JSON.stringify({
        options: [{ value: "suggested-remote", label: "Suggested remote" }]
      }), { headers: { "content-type": "application/json" } });
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
      const [values, setValues] = useState({ mode: "a", ids: ["saved"], limit: 0.5, tags: ["known"] });
      window.__formValues = values;
      const [options, setOptions] = useState([{ value: "saved", label: "Saved title", title: "Saved title" }]);
      const remember = useCallback((key, page) => {
        window.__optionUpdates.push({ key, page });
        if (key === "ids") setOptions(current =>
          [...new Map([...current, ...page].map(option => [option.value, option])).values()]);
      }, []);
      return <div role="dialog" aria-modal="true" aria-label="Connector form fixture"
        onClick={() => { window.__dialogClicks = (window.__dialogClicks ?? 0) + 1; }}
        onKeyDown={event => { if (event.key === "Escape") window.__dialogEscapes = (window.__dialogEscapes ?? 0) + 1; }}>
        <form id="fixture" onSubmit={event => {
        event.preventDefault(); window.__formSubmits = (window.__formSubmits ?? 0) + 1;
      }}>
        <button id="dependency" type="button" onClick={() => setValues(current => ({ ...current, mode: "b" }))}>
          Change dependency
        </button>
        <ConnectorFormFields connectorType="fixture" fields={[
          { key: "ids", label: "IDs", type: "string_array", required: true, dynamic_options: true,
            options_depends_on: ["mode"], options },
          { key: "limit", label: "Limit", type: "number", required: true, min: 0, max: 1,
            description: "Set a value between zero and one." },
          { key: "tags", label: "Tags", type: "string_array", required: false, allow_custom: true,
            options: [{ value: "known", label: "Known" }] },
          { key: "remote", label: "Remote", type: "string", required: false, allow_custom: true, dynamic_options: true }
        ]} values={values} credentials={{}} busy={false} loading={false} optionsEnabled={true}
          onChange={(key, value) => setValues(current => ({ ...current, [key]: value }))}
          onOptions={remember} />
      </form></div>;
    }
    const kind = {
      connector_type: "actions-fixture", title: "Fixture", description: "", credential_hint: "",
      installed: true, instance_count: 3, setup_ready: true, singleton: true,
      fields: [], prerequisites: [], setup_steps: [], docs: []
    };
    const installations = ["enabled", "disabled", "needs_attention"].map(status => ({
      id: status, connector_type: kind.connector_type, status, label: status, detail: null,
      syncable: false, can_reply: false, can_create: false, last_attempt: null
    }));
    createRoot(document.getElementById("root")).render(<React.StrictMode>
      <Fixture />
      <ConnectorKind kind={kind} installations={installations} busyId={null} syncingAll={false}
        installing={false} pendingUninstall={false} onOpenInstall={() => {}} onCloseInstall={() => {}}
        onInstall={() => {}} onSync={() => {}} onRetryQuarantines={() => {}}
        onEnable={installation => { window.__enabledInstallation = installation.id; }}
        onUpdate={async () => true}
        onUninstall={installation => { window.__uninstalledInstallation = installation.id; }} />
    </React.StrictMode>);
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
