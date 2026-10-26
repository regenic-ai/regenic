export const SYSTEM_RECIPE_PREFIX = "system:";
export const SEARCH_ANSWER_PURPOSE = "search-answer";
export const SEARCH_ANSWER_WORK_ITEM_PREFIX = `${SEARCH_ANSWER_PURPOSE}:`;
export const SEARCH_ANSWER_TIMEOUT_MS = 5 * 60_000;

export function systemRecipeId(purpose: string, executorType: string): string {
  return `${SYSTEM_RECIPE_PREFIX}${purpose}:${executorType}`;
}

export function isSystemRecipeId(id: string | undefined): boolean {
  return Boolean(id?.startsWith(SYSTEM_RECIPE_PREFIX));
}

export function isSearchAnswerRecipeId(id: string | undefined): boolean {
  return Boolean(id?.startsWith(
    `${SYSTEM_RECIPE_PREFIX}${SEARCH_ANSWER_PURPOSE}:`,
  ));
}

export function searchAnswerIdFromWorkItem(id: string): string | undefined {
  return id.startsWith(SEARCH_ANSWER_WORK_ITEM_PREFIX)
    ? id.slice(SEARCH_ANSWER_WORK_ITEM_PREFIX.length) || undefined
    : undefined;
}
