export const SYSTEM_RECIPE_PREFIX = "system:";
export const SEARCH_ANSWER_PURPOSE = "search-answer";
export const SEARCH_ANSWER_WORK_ITEM_PREFIX = `${SEARCH_ANSWER_PURPOSE}:`;
export const SEARCH_ANSWER_MAP_PURPOSE = "search-answer-map";
export const SEARCH_ANSWER_MAP_WORK_ITEM_PREFIX = `${SEARCH_ANSWER_MAP_PURPOSE}:`;
export const SEARCH_ANSWER_TIMEOUT_MS = 5 * 60_000;

export function systemRecipeId(purpose: string, executorType: string): string {
  return `${SYSTEM_RECIPE_PREFIX}${purpose}:${executorType}`;
}

export function isSystemRecipeId(id: string | undefined): boolean {
  return Boolean(id?.startsWith(SYSTEM_RECIPE_PREFIX));
}

export function isSearchAnswerRecipeId(id: string | undefined): boolean {
  return Boolean(
    id?.startsWith(`${SYSTEM_RECIPE_PREFIX}${SEARCH_ANSWER_PURPOSE}:`)
    || id?.startsWith(`${SYSTEM_RECIPE_PREFIX}${SEARCH_ANSWER_MAP_PURPOSE}:`),
  );
}

export function searchAnswerIdFromWorkItem(id: string): string | undefined {
  if (id.startsWith(SEARCH_ANSWER_WORK_ITEM_PREFIX)) {
    return id.slice(SEARCH_ANSWER_WORK_ITEM_PREFIX.length) || undefined;
  }
  if (id.startsWith(SEARCH_ANSWER_MAP_WORK_ITEM_PREFIX)) {
    const value = id.slice(SEARCH_ANSWER_MAP_WORK_ITEM_PREFIX.length);
    const separator = value.indexOf(":");
    return separator > 0 ? value.slice(0, separator) : undefined;
  }
  return undefined;
}
