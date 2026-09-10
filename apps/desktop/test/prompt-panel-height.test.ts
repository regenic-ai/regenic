import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PROMPT_PANEL_HEIGHT_KEY,
  PROMPT_PANEL_MIN_HEIGHT,
  clampPromptPanelHeight,
  promptPanelAvailableHeight,
  readPromptPanelHeight,
  writePromptPanelHeight,
  type PromptHeightStore,
} from "../src/renderer/src/prompt-panel-height.ts";

function memoryStore(): PromptHeightStore {
  const data = new Map<string, string>();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

describe("prompt panel height", () => {
  it("clamps to a usable min and leaves transcript room", () => {
    assert.equal(clampPromptPanelHeight(40, 800), PROMPT_PANEL_MIN_HEIGHT);
    assert.equal(clampPromptPanelHeight(900, 800), 680);
    assert.equal(clampPromptPanelHeight(300, 800), 300);
  });

  it("subtracts the thread head from available room", () => {
    assert.equal(promptPanelAvailableHeight(800, 200), 600);
    assert.equal(clampPromptPanelHeight(900, promptPanelAvailableHeight(800, 200)), 480);
  });

  it("round-trips through a store", () => {
    const store = memoryStore();
    writePromptPanelHeight(null, store);
    assert.equal(readPromptPanelHeight(store), null);
    writePromptPanelHeight(280.6, store);
    assert.equal(store.getItem(PROMPT_PANEL_HEIGHT_KEY), "281");
    assert.equal(readPromptPanelHeight(store), 281);
    writePromptPanelHeight(null, store);
    assert.equal(readPromptPanelHeight(store), null);
  });
});
