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
  window.webContents.on("console-message", (event) => {
    if (event.level === "error") console.error("Recipe renderer:", event.message);
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
    assert.equal(await window.webContents.executeJavaScript(`(() => {
      const row = [...document.querySelectorAll(".recipe-row")]
        .find(item => item.querySelector(".recipe-row-label")?.textContent.trim() === "Playbook");
      return Boolean(row?.querySelector("textarea[required]"));
    })()`), true, "The shared task instruction must appear even without a prompt catalog field");
    assert.equal(await window.webContents.executeJavaScript(
      'document.querySelector(\'.recipe-form button[type="submit"]\').disabled',
    ), true, "A new rule without a task instruction must not be saveable");
    await window.webContents.executeJavaScript(`(() => {
      const row = [...document.querySelectorAll(".recipe-row")]
        .find(item => item.querySelector(".recipe-row-label")?.textContent.trim() === "Playbook");
      const textarea = row?.querySelector("textarea");
      if (!textarea) throw new Error("Missing shared task instruction");
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(
        textarea, "Handle each matching task."
      );
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await window.webContents.executeJavaScript(
      'document.querySelector(\'.recipe-form button[type="submit"]\').disabled',
    ), false, "A non-empty shared task instruction must unblock saving");
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
    })()`), false, "Keep here hides the destination picker without discarding the destination");
    const addCondition = async (label) => {
      await window.webContents.executeJavaScript(
        'document.querySelector(\'button[aria-label="Add condition"]\').click()',
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      await window.webContents.executeJavaScript(`(() => {
        const option = [...document.querySelectorAll('[role="option"]')]
          .find(item => item.textContent.trim() === ${JSON.stringify(label)});
        if (!option) throw new Error("Missing add-condition option");
        option.click();
      })()`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    };
    assert.equal(await window.webContents.executeJavaScript(
      'document.querySelectorAll(".recipe-condition input").length',
    ), 0, "New rules should not show two empty condition inputs");
    await addCondition("Body contains");
    assert.equal(await window.webContents.executeJavaScript(
      'document.activeElement?.getAttribute("aria-label")',
    ), "Body contains", "Adding a condition must focus its value");
    await window.webContents.executeJavaScript(
      'document.querySelector(".recipe-form").requestSubmit()',
    );
    assert.equal(await window.webContents.executeJavaScript(
      'Boolean(window.__savedRecipe)',
    ), false, "An empty added condition must not silently save as an unfiltered rule");
    await addCondition("Body does not contain");
    assert.equal(await window.webContents.executeJavaScript(
      'Boolean(document.querySelector(\'button[aria-label="Add condition"]\'))',
    ), false, "Do not offer unsupported duplicate conditions");
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
    await setFilters("   ", "DRAFT");
    await window.webContents.executeJavaScript(
      'document.querySelector(".recipe-form").requestSubmit()',
    );
    assert.equal(await window.webContents.executeJavaScript(
      'Boolean(window.__savedRecipe)',
    ), false, "Whitespace-only conditions must not silently save as an unfiltered rule");
    await setFilters("APPROVE", "RELEASE");
    assert.match(await window.webContents.executeJavaScript(
      'document.querySelector(".recipe-preview-body").textContent',
    ), /No matching chats/, "Exclusion must update the real editor preview");
    await setFilters("APPROVE", "DRAFT");
    assert.match(await window.webContents.executeJavaScript(
      'document.querySelector(".recipe-preview-body").textContent',
    ), /Filter smoke chat/, "Matching body must appear in the real editor preview");
    await window.webContents.executeJavaScript('document.querySelector(".recipe-condition-test-toggle").click()');
    const testMessage = async (value) => {
      await window.webContents.executeJavaScript(`(() => {
        const input = document.querySelector(".recipe-condition-test textarea");
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(input, ${JSON.stringify(value)});
        input.dispatchEvent(new Event("input", { bubbles: true }));
      })()`);
      await new Promise((resolve) => setTimeout(resolve, 50));
      return window.webContents.executeJavaScript(
        'document.querySelector(".recipe-condition-result").getAttribute("data-result")',
      );
    };
    assert.equal(await testMessage("approve release"), "pass");
    assert.equal(await testMessage("APPROVE this DRAFT"), "fail");
    assert.match(await window.webContents.executeJavaScript(
      'document.querySelector(".recipe-condition-test").textContent',
    ), /Contains excluded text/, "Explain why an excluded sample fails");
    assert.equal(await testMessage("release"), "fail");
    assert.match(await window.webContents.executeJavaScript(
      'document.querySelector(".recipe-condition-test").textContent',
    ), /Missing required text/, "Explain why a missing required substring fails");
    assert.equal(await testMessage(""), "idle");
    assert.equal(await testMessage("approve release"), "pass");
    assert.equal(await window.webContents.executeJavaScript(
      'Boolean(window.__savedRecipe)',
    ), false, "Local text tests must not save or execute the rule");
    await window.webContents.executeJavaScript(
      'document.querySelector(\'button[aria-label="Remove does-not-contain condition"]\').click()',
    );
    assert.equal(await window.webContents.executeJavaScript(
      'document.querySelector(\'input[aria-label="Body contains"]\').value',
    ), "APPROVE", "Removing a condition must preserve the other value");
    await addCondition("Body does not contain");
    await setFilters("APPROVE", "DRAFT");
    await window.webContents.executeJavaScript(
      'document.querySelector(\'input[aria-label="Body contains"]\').scrollIntoView({ block: "start" })',
    );
    writeFileSync(join(process.env.REGENIC_SMOKE_OUTPUT, "filters.png"),
      (await window.webContents.capturePage()).toPNG());
    for (const [width, height] of [[800, 800], [1000, 800], [1099, 800], [1100, 800],
      [1186, 800], [1440, 800], [1920, 800], [1186, 600], [600, 800], [480, 800]]) {
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
      const filterLayout = await window.webContents.executeJavaScript(`(async () => {
        const group = document.querySelector(".recipe-conditions");
        group.scrollIntoView({ block: "center" });
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const bounds = group.getBoundingClientRect();
        return [...group.querySelectorAll("input, textarea, .recipe-condition-remove")].every(input => {
          const box = input.getBoundingClientRect();
          return box.width > 20 && box.left >= bounds.left && box.right <= bounds.right;
        });
      })()`);
      assert.equal(filterLayout, true, `Condition controls must fit at ${width}x${height}`);
      writeFileSync(join(process.env.REGENIC_SMOKE_OUTPUT, `filters-${width}x${height}.png`),
        (await window.webContents.capturePage()).toPNG());
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
        if (document.querySelector(".recipe-condition input")) throw new Error("New draft retained old condition rows after save");
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
    await window.webContents.executeJavaScript(
      'document.querySelector(\'button[aria-label="Remove contains condition"]\').click()',
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    await window.webContents.executeJavaScript(
      'document.querySelector(\'button[aria-label="Remove does-not-contain condition"]\').click()',
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(await window.webContents.executeJavaScript(
      'document.querySelectorAll(".recipe-condition input").length',
    ), 0);
    assert.equal(await window.webContents.executeJavaScript(
      'document.activeElement?.getAttribute("aria-label")',
    ), "Add condition", "Removing the last condition must restore a reachable add action");
    await window.webContents.executeJavaScript(
      'document.querySelector(".recipe-form").requestSubmit()',
    );
    for (let attempt = 0; ; attempt++) {
      const cleared = await window.webContents.executeJavaScript(
        'window.__savedRecipe.match.text_contains === undefined && window.__savedRecipe.match.text_excludes === undefined',
      );
      if (cleared) break;
      assert.ok(attempt < 50, "Removing all conditions must persist an unfiltered rule");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    for (let attempt = 0; ; attempt++) {
      const ready = await window.webContents.executeJavaScript(`(() => {
        if (document.querySelector('.recipe-form button[type="submit"]').textContent.trim() === "Saving…") return false;
        const card = document.querySelector(".recipe-card-hit");
        if (!card) return false;
        card.click();
        return true;
      })()`);
      if (ready) break;
      assert.ok(attempt < 50, "Updated recipe did not finish saving");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    await addCondition("Body contains");
    await window.webContents.executeJavaScript(`(() => {
      window.__confirmCalls = 0;
      window.confirm = () => { window.__confirmCalls++; return true; };
      const button = [...document.querySelectorAll(".recipe-form-foot button")]
        .find(item => item.textContent.trim() === "Try once");
      if (!button || button.disabled) throw new Error("Missing enabled trial action");
      button.click();
    })()`);
    assert.equal(await window.webContents.executeJavaScript(
      'window.__confirmCalls',
    ), 0, "A new blank condition must block trial before confirmation, even when the persisted payload is unchanged");
    const switchTrigger = async (label) => {
      await window.webContents.executeJavaScript(`(() => {
        const button = [...document.querySelectorAll(".recipe-form .seg button")]
          .find(item => item.textContent.trim() === ${JSON.stringify(label)});
        if (!button) throw new Error("Missing trigger option");
        button.click();
      })()`);
      await new Promise((resolve) => setTimeout(resolve, 75));
    };
    const tryOnce = async () => {
      const before = await window.webContents.executeJavaScript('window.__tryCalls ?? 0');
      await window.webContents.executeJavaScript(`(() => {
        const button = [...document.querySelectorAll(".recipe-form-foot button")]
          .find(item => item.textContent.trim() === "Try once");
        if (!button || button.disabled) throw new Error("Trial action is disabled");
        button.click();
      })()`);
      for (let attempt = 0; ; attempt++) {
        if (await window.webContents.executeJavaScript(`(window.__tryCalls ?? 0) > ${before} &&
          ![...document.querySelectorAll(".recipe-form-foot button")].find(item => item.textContent.trim() === "Try once").disabled`)) break;
        assert.ok(attempt < 50, "Trial request was blocked or failed to settle");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };
    const assertInactive = async () => {
      assert.equal(await window.webContents.executeJavaScript(
        'document.querySelectorAll(".recipe-condition input, .recipe-conditions textarea").length',
      ), 0, "Inactive condition editor must not leave hidden required inputs");
      assert.equal(await window.webContents.executeJavaScript(`(() => {
        return Boolean(document.querySelector(".recipe-conditions, .recipe-conditions-inactive")) ||
          [...document.querySelectorAll(".recipe-row-label")].some(item => item.textContent.trim() === "Conditions") ||
          /conditions apply only|conditions are kept|Message conditions inactive/.test(document.querySelector(".recipe-form").textContent);
      })()`), false, "Non-push modes must omit the entire condition section and explanatory copy");
      assert.match(await window.webContents.executeJavaScript(
        'document.querySelector(".recipe-preview-body").textContent',
      ), /Filter smoke chat/, "Inactive filters must not restrict scope preview");
    };
    await switchTrigger("Only when I ask");
    await assertInactive();
    await tryOnce();
    assert.equal(await window.webContents.executeJavaScript(
      'document.querySelector(".recipe-form").checkValidity()',
    ), true, "A retained empty condition must not invalidate a manual trial");
    await switchTrigger("On a new message");
    assert.equal(await window.webContents.executeJavaScript(
      'document.querySelector(\'input[aria-label="Body contains"]\').value',
    ), "", "Switching back must preserve an unfinished added row");
    await addCondition("Body does not contain");
    await setFilters("MISSING", "RELEASE");
    for (const [kind, label] of [["pull", "On a schedule"], ["manual", "Only when I ask"], ["push", "On a new message"]]) {
      await switchTrigger(label);
      if (kind === "push") {
        assert.deepEqual(await window.webContents.executeJavaScript(`[
          document.querySelector('input[aria-label="Body contains"]').value,
          document.querySelector('input[aria-label="Body does not contain"]').value
        ]`), ["MISSING", "RELEASE"]);
        assert.match(await window.webContents.executeJavaScript(
          'document.querySelector(".recipe-preview-body").textContent',
        ), /No matching chats/);
      } else {
        await assertInactive();
        if (kind === "pull") {
          assert.match(await window.webContents.executeJavaScript(
            'document.querySelector(".recipe-form").textContent',
          ), /what to read.*what to select.*nothing matches.*available tools/s);
        }
      }
      const count = await window.webContents.executeJavaScript('window.__saveCount');
      await window.webContents.executeJavaScript('document.querySelector(".recipe-form").requestSubmit()');
      for (let attempt = 0; ; attempt++) {
        const saved = await window.webContents.executeJavaScript(`window.__saveCount > ${count} &&
          document.querySelector('.recipe-form button[type="submit"]').textContent.trim() !== "Saving…"`);
        if (saved) break;
        assert.ok(attempt < 50, "Trigger-aware rule was not saved");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const payload = await window.webContents.executeJavaScript('window.__savedRecipe');
      assert.equal(payload.trigger.kind, kind);
      assert.equal(payload.match.text_contains, "MISSING");
      assert.equal(payload.match.text_excludes, "RELEASE");
      await window.webContents.executeJavaScript('document.querySelector(".recipe-card-hit").click()');
      await new Promise((resolve) => setTimeout(resolve, 75));
      if (kind !== "push") {
        await assertInactive();
        assert.doesNotMatch(await window.webContents.executeJavaScript(
          'document.querySelector(".recipe-card-hit").textContent',
        ), /Message conditions inactive|contains “|excludes “/);
      }
      await tryOnce();
      for (const [width, height] of [[1186, 800], [480, 800]]) {
        window.setContentSize(width, height);
        await new Promise((resolve) => setTimeout(resolve, 100));
        const gap = await window.webContents.executeJavaScript(`(async () => {
          const page = document.querySelector(".page-recipes");
          page.scrollTop = page.scrollHeight;
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const cards = page.querySelectorAll(":scope > section.card");
          const editor = document.querySelector(".recipe-editor").getBoundingClientRect();
          const footer = document.querySelector(".recipe-form-foot").getBoundingClientRect();
          if (footer.bottom > editor.bottom + 1) throw new Error("Footer escapes editor");
          return page.getBoundingClientRect().bottom - Math.max(...[...cards].map(card => card.getBoundingClientRect().bottom));
        })()`);
        assert.ok(Math.abs(gap - 28) <= 1, `${kind} footer must keep its 28px gap at ${width}x${height}: ${gap}`);
        writeFileSync(join(process.env.REGENIC_SMOKE_OUTPUT, `${kind}-${width}x${height}.png`),
          (await window.webContents.capturePage()).toPNG());
      }
    }
    await setFilters("   ", "RELEASE");
    await switchTrigger("Only when I ask");
    assert.equal(await window.webContents.executeJavaScript(
      'document.querySelector(".recipe-form").checkValidity()',
    ), true, "Inactive whitespace must not create hidden validation");
    await switchTrigger("On a new message");
    assert.equal(await window.webContents.executeJavaScript(
      'document.querySelector(\'input[aria-label="Body contains"]\').checkValidity()',
    ), false, "Switching back must restore whitespace validation along with its draft value");
    console.log("Recipe filter trigger switching, trial, preview, save and edit smoke passed");
    await switchTrigger("Only when I ask");
    const clickText = async (label) => {
      await window.webContents.executeJavaScript(`(() => {
        const button = [...document.querySelectorAll(".recipe-form button")]
          .find(item => item.textContent.trim() === ${JSON.stringify(label)});
        if (!button || button.disabled) throw new Error("Missing enabled action: " + ${JSON.stringify(label)});
        button.click();
      })()`).catch((error) => { throw new Error(`Action failed: ${label}`, { cause: error }); });
      await new Promise((resolve) => setTimeout(resolve, 75));
    };
    const setConversations = async (sourceCanSend, resultCanSend) => {
      await window.webContents.executeJavaScript(`window.__setConversations([
        { id: "smoke:room", label: "Filter smoke chat", source: "smoke",
          record_class: "utterance", thread_facet: "chat", can_send: ${sourceCanSend} },
        { id: "results:room", label: "Writable result chat", source: "results", can_send: ${resultCanSend} },
        { id: "unknown:room", label: "Unknown capability", source: "unknown" }
      ])`);
      await new Promise((resolve) => setTimeout(resolve, 75));
    };
    const pickDestination = async (value) => {
      console.log("Picking destination:", value);
      await window.webContents.executeJavaScript(
        'document.querySelector(\'button[aria-label="Send result to"]\').click()',
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      const options = await window.webContents.executeJavaScript(
        '[...document.querySelectorAll(\'[role="option"]\')].map(item => item.textContent.trim())',
      );
      assert.equal(options.includes("Unknown capability"), false);
      await window.webContents.executeJavaScript(`(() => {
        const option = [...document.querySelectorAll('[role="option"]')]
          .find(item => item.textContent.trim() === ${JSON.stringify(value)});
        if (!option) throw new Error("Missing destination: " + ${JSON.stringify(value)});
        option.click();
      })()`);
      await new Promise((resolve) => setTimeout(resolve, 75));
      return options;
    };
    const saveAndReopen = async () => {
      const count = await window.webContents.executeJavaScript('window.__saveCount');
      await window.webContents.executeJavaScript('document.querySelector(".recipe-form").requestSubmit()');
      for (let attempt = 0; ; attempt++) {
        if (await window.webContents.executeJavaScript(`window.__saveCount > ${count} &&
          document.querySelector('.recipe-form button[type="submit"]').textContent.trim() !== "Saving…"`)) break;
        assert.ok(attempt < 50, "Destination save did not settle");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await window.webContents.executeJavaScript('document.querySelector(".recipe-card-hit").click()');
      await new Promise((resolve) => setTimeout(resolve, 75));
    };
    await setConversations(false, true);
    await clickText("Send back");
    assert.deepEqual(await pickDestination("Writable result chat"), ["Writable result chat"],
      "A read-only original must not prevent picking another writable destination");
    await saveAndReopen();
    let delivery = await window.webContents.executeJavaScript('window.__savedRecipe');
    assert.equal(delivery.can_write_back, true);
    assert.equal(delivery.write_back_thread_id, "results:room");
    await clickText("Try & send back");
    assert.equal(await window.webContents.executeJavaScript('window.__lastTry.write_back'), true);
    assert.equal(await window.webContents.executeJavaScript('window.__lastTry.thread_id'), "smoke:room");
    await clickText("Keep here");
    await saveAndReopen();
    assert.equal(await window.webContents.executeJavaScript('window.__savedRecipe.can_write_back'), false);
    assert.equal(await window.webContents.executeJavaScript('window.__savedRecipe.write_back_thread_id'), "results:room");
    await clickText("Send back");
    await setConversations(true, true);
    await pickDestination("Original conversation");
    await saveAndReopen();
    assert.equal(await window.webContents.executeJavaScript('window.__savedRecipe.write_back_thread_id'), null);
    await pickDestination("Writable result chat");
    await saveAndReopen();
    await setConversations(false, false);
    assert.match(await window.webContents.executeJavaScript(
      'document.querySelector(\'button[aria-label="Send result to"]\').textContent',
    ), /Writable result chat.*unavailable/);
    assert.equal(await window.webContents.executeJavaScript(
      'document.querySelector(\'button[aria-label="Send result to"]\').disabled',
    ), true, "No unavailable target may be a new option");
    assert.match(await window.webContents.executeJavaScript(
      'document.querySelector(".recipe-form").textContent',
    ), /No available conversations/);
    assert.equal(await window.webContents.executeJavaScript(`(() => {
      const buttons = [...document.querySelectorAll(".recipe-form button")];
      return buttons.find(item => item.textContent.trim() === "Send back").disabled;
    })()`), false, "Send back always represents selectable intent, even with no candidates");
    assert.equal(await window.webContents.executeJavaScript(`(() => {
      return [...document.querySelectorAll(".recipe-form button")]
        .find(item => item.textContent.trim() === "Try & send back").disabled;
    })()`), true, "Unavailable destinations must block send trials");
    await saveAndReopen();
    delivery = await window.webContents.executeJavaScript('window.__savedRecipe');
    assert.equal(delivery.can_write_back, true, "Unrelated saves must preserve unavailable delivery intent");
    assert.equal(delivery.write_back_thread_id, "results:room");
    await clickText("Keep here");
    await saveAndReopen();
    await clickText("Send back");
    assert.equal(await window.webContents.executeJavaScript(
      'document.querySelector(\'.recipe-form button[type="submit"]\').disabled',
    ), true, "Re-enabling send with no valid target must block saving");
    const before = await window.webContents.executeJavaScript('window.__saveCount');
    await window.webContents.executeJavaScript('document.querySelector(".recipe-form").requestSubmit()');
    await new Promise((resolve) => setTimeout(resolve, 75));
    assert.equal(await window.webContents.executeJavaScript('window.__saveCount'), before);
    for (const width of [1186, 480]) {
      window.setContentSize(width, 800);
      await window.webContents.executeJavaScript(
        'document.querySelector(\'button[aria-label="Send result to"]\').scrollIntoView({ block: "center" })',
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(await window.webContents.executeJavaScript(`(() => {
        const name = document.querySelector(".recipe-name input").getBoundingClientRect();
        const actions = document.querySelector(".recipe-actions").getBoundingClientRect();
        return name.width >= 120 && (name.right <= actions.left || name.bottom <= actions.top);
      })()`), true, "Destination trial controls must not squeeze or overlap the rule name");
      writeFileSync(join(process.env.REGENIC_SMOKE_OUTPUT, `destination-empty-${width}.png`),
        (await window.webContents.capturePage()).toPNG());
    }
    await clickText("Keep here");
    assert.equal(await window.webContents.executeJavaScript(
      'document.querySelector(\'.recipe-form button[type="submit"]\').disabled',
    ), false);
    await clickText("Cancel");
    await clickText("All tasks");
    await window.webContents.executeJavaScript(`(() => {
      const row = [...document.querySelectorAll(".recipe-row")]
        .find(item => item.querySelector(".recipe-row-label")?.textContent.trim() === "Playbook");
      const textarea = row.querySelector("textarea");
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(textarea, "Local fixture task");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    })()`);
    await clickText("Send back");
    assert.equal(await window.webContents.executeJavaScript(
      'document.querySelector(\'.recipe-form button[type="submit"]\').disabled',
    ), true, "A new send rule must not save without an available destination");
    assert.match(await window.webContents.executeJavaScript(
      'document.querySelector(\'button[aria-label="Send result to"]\').textContent',
    ), /No available conversations/);
    await window.webContents.executeJavaScript(
      'document.querySelector(\'button[aria-label="Send result to"]\').scrollIntoView({ block: "center" })',
    );
    await new Promise((resolve) => setTimeout(resolve, 75));
    writeFileSync(join(process.env.REGENIC_SMOKE_OUTPUT, "destination-new-empty.png"),
      (await window.webContents.capturePage()).toPNG());
    await clickText("Keep here");
    assert.equal(await window.webContents.executeJavaScript(
      'document.querySelector(\'.recipe-form button[type="submit"]\').disabled',
    ), false, "Keeping a new rule local needs no sendable conversation");
    console.log("Destination intent, candidates, empty/legacy states, save/edit and send-trial smoke passed");
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
          { key: "skill", label: "Skill", kind: "text", hint: "Optional skill" }
        ]
      }]
    };
    window.fetch = async (input, init) => {
      const path = new URL(String(input), location.href).pathname;
      if (path === "/v1/me/recipes/smoke-rule/try" && init?.method === "POST") {
        window.__lastTry = JSON.parse(init.body);
        window.__tryCalls = (window.__tryCalls ?? 0) + 1;
        return new Response(JSON.stringify({ thread_id: "smoke:room" }), { headers: { "content-type": "application/json" } });
      }
      if ((path === "/v1/me/recipes" || path === "/v1/me/recipes/smoke-rule") && init?.method === "POST") {
        const recipe = { ...JSON.parse(init.body), id: "smoke-rule", org_id: "local-owner",
          created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
        window.__savedRecipe = recipe;
        window.__saveCount = (window.__saveCount ?? 0) + 1;
        fixtures["/v1/me/recipes"] = [recipe];
        return new Response(JSON.stringify(recipe), { headers: { "content-type": "application/json" } });
      }
      if (!(path in fixtures)) throw new Error("Unexpected smoke request: " + path);
      return new Response(JSON.stringify(fixtures[path]), { headers: { "content-type": "application/json" } });
    };
    function Fixture() {
      const [conversations, setConversations] = React.useState([{
        id: "smoke:room", label: "Filter smoke chat", source: "smoke", can_send: true,
        record_class: "utterance", thread_facet: "chat", body_text: "approve release"
      }]);
      window.__setConversations = setConversations;
      return (
      <div className="shell">
        <header className="titlebar">Recipe layout smoke</header>
        <nav className="rail" />
        <div className="workspace"><RecipesPage sources={[]} conversations={conversations} seed={seed} /></div>
      </div>
      );
    }
    const seed = { thread_id: "smoke:room", title: "Filter smoke chat" };
    createRoot(document.getElementById("root")).render(<Fixture />);
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
