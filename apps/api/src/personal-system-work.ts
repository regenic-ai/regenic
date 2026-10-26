export const SYSTEM_RECIPE_PREFIX = "system:";

export function systemRecipeId(purpose: string, executorType: string): string {
  return `${SYSTEM_RECIPE_PREFIX}${purpose}:${executorType}`;
}

export function isSystemRecipeId(id: string | undefined): boolean {
  return Boolean(id?.startsWith(SYSTEM_RECIPE_PREFIX));
}
