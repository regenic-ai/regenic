/** Session-scoped Prompt panel height (px). Null = natural height (default). */

export const PROMPT_PANEL_HEIGHT_KEY = "regenic.promptPanelHeight";
/** Enough for kicker + title + Continue. */
export const PROMPT_PANEL_MIN_HEIGHT = 140;
/** Leave room for the message list above the dock. */
export const PROMPT_PANEL_MIN_TRANSCRIPT = 120;

export type PromptHeightStore = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function clampPromptPanelHeight(
  height: number,
  paneHeight: number,
): number {
  const max = Math.max(
    PROMPT_PANEL_MIN_HEIGHT,
    Math.floor(paneHeight - PROMPT_PANEL_MIN_TRANSCRIPT),
  );
  return Math.min(max, Math.max(PROMPT_PANEL_MIN_HEIGHT, Math.round(height)));
}

function defaultStore(): PromptHeightStore | null {
  if (typeof sessionStorage === "undefined") {
    return null;
  }
  try {
    return sessionStorage;
  } catch {
    return null;
  }
}

export function readPromptPanelHeight(
  store: PromptHeightStore | null = defaultStore(),
): number | null {
  if (!store) {
    return null;
  }
  try {
    const raw = store.getItem(PROMPT_PANEL_HEIGHT_KEY);
    if (!raw) {
      return null;
    }
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      return null;
    }
    return Math.round(value);
  } catch {
    return null;
  }
}

export function writePromptPanelHeight(
  height: number | null,
  store: PromptHeightStore | null = defaultStore(),
): void {
  if (!store) {
    return;
  }
  try {
    if (height == null) {
      store.removeItem(PROMPT_PANEL_HEIGHT_KEY);
      return;
    }
    store.setItem(PROMPT_PANEL_HEIGHT_KEY, String(Math.round(height)));
  } catch {
    // Ignore quota / private-mode failures.
  }
}
