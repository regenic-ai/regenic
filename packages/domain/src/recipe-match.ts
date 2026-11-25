import type { RecordClass } from "./record-class";
import type { ThreadFacet } from "./thread-facet";
import type { Recipe, RecipeMatch, RecipeTriggerKind } from "./work";

export interface RecipeSubject {
  record_class: RecordClass;
  thread_facet: ThreadFacet;
  source: string;
  thread_id: string;
  unit_kind?: string;
  body_text?: string;
  /** Display title: a renamed conversation wins over the app's conversation label. */
  title?: string;
}

/** Title a recipe filter should see. Custom names win; whitespace is collapsed. */
export function recipeConversationTitle(input: {
  customTitle?: string | null;
  conversationLabel?: string | null;
}): string | undefined {
  for (const value of [input.customTitle, input.conversationLabel]) {
    const title = value?.replace(/\s+/g, " ").trim();
    if (title) {
      return title;
    }
  }
  return undefined;
}

export const RECIPE_MATCH_WEIGHTS = {
  thread_id: 16,
  unit_kind: 8,
  source: 4,
  record_class: 2,
  thread_facet: 1,
  /** A name filter splits one app, so it beats that app with no name filter. */
  conversation_name: 1,
} as const;

/**
 * Fields the automation form actually offers.
 * One app is the app and optional task type. One chat is that chat.
 * All tasks is the task class, plus a task type when one was chosen.
 * A stored record class on an app or chat rule is not a form control.
 */
export function visibleScopeMatch(match: RecipeMatch): RecipeMatch {
  const text = {
    ...(match.text_contains ? { text_contains: match.text_contains } : {}),
    ...(match.text_excludes ? { text_excludes: match.text_excludes } : {}),
  };
  if (match.thread_id?.trim()) {
    return { thread_id: match.thread_id.trim(), ...text };
  }
  if (match.source?.trim()) {
    const unitKind = match.unit_kind?.trim();
    return {
      source: match.source.trim(),
      ...(unitKind ? { unit_kind: unitKind } : {}),
      ...text,
      ...(match.title_contains ? { title_contains: match.title_contains } : {}),
      ...(match.title_excludes ? { title_excludes: match.title_excludes } : {}),
    };
  }
  const unitKind = match.unit_kind?.trim();
  return {
    ...(match.record_class ? { record_class: match.record_class } : {}),
    ...(unitKind ? { unit_kind: unitKind } : {}),
    ...(match.thread_facet ? { thread_facet: match.thread_facet } : {}),
    ...text,
  };
}

export function recipeSpecificity(match: RecipeMatch): number {
  const visible = visibleScopeMatch(match);
  let score = 0;
  if (visible.thread_id) {
    score += RECIPE_MATCH_WEIGHTS.thread_id;
  }
  if (visible.unit_kind) {
    score += RECIPE_MATCH_WEIGHTS.unit_kind;
  }
  if (visible.source) {
    score += RECIPE_MATCH_WEIGHTS.source;
  }
  if (visible.record_class) {
    score += RECIPE_MATCH_WEIGHTS.record_class;
  }
  if (visible.thread_facet) {
    score += RECIPE_MATCH_WEIGHTS.thread_facet;
  }
  if (visible.title_contains || visible.title_excludes) {
    score += RECIPE_MATCH_WEIGHTS.conversation_name;
  }
  return score;
}

export function recipeMatches(
  match: RecipeMatch,
  subject: RecipeSubject,
  triggerKind: RecipeTriggerKind = "push",
): boolean {
  match = visibleScopeMatch(match);
  if (recipeSpecificity(match) === 0) {
    return false;
  }
  if (match.thread_id && match.thread_id !== subject.thread_id) {
    return false;
  }
  if (match.unit_kind && match.unit_kind !== subject.unit_kind) {
    return false;
  }
  if (match.source && match.source !== subject.source) {
    return false;
  }
  if (match.record_class && match.record_class !== subject.record_class) {
    return false;
  }
  if (match.thread_facet && match.thread_facet !== subject.thread_facet) {
    return false;
  }
  if (triggerKind === "push" && !recipeTextMatches(match, subject.body_text)) {
    return false;
  }
  return recipeTitleMatches(match, subject.title);
}

function literalSubstringMatches(
  contains: string | undefined,
  excludes: string | undefined,
  text: string | undefined,
): boolean {
  if (!contains && !excludes) {
    return true;
  }
  // Missing content is not proof that an exclusion passes.
  if (text === undefined) {
    return false;
  }
  const folded = text.toLowerCase();
  return (
    (!contains || folded.includes(contains.toLowerCase())) &&
    (!excludes || !folded.includes(excludes.toLowerCase()))
  );
}

export function recipeTextMatches(match: RecipeMatch, text: string | undefined): boolean {
  return literalSubstringMatches(match.text_contains, match.text_excludes, text);
}

export function recipeTitleMatches(match: RecipeMatch, title: string | undefined): boolean {
  return literalSubstringMatches(match.title_contains, match.title_excludes, title);
}

function substringFiltersConflict(
  leftContains: string | undefined,
  leftExcludes: string | undefined,
  rightContains: string | undefined,
  rightExcludes: string | undefined,
): boolean {
  return Boolean(
    (leftContains &&
      rightExcludes &&
      leftContains.toLowerCase().includes(rightExcludes.toLowerCase())) ||
      (rightContains &&
        leftExcludes &&
        rightContains.toLowerCase().includes(leftExcludes.toLowerCase())),
  );
}

export function recipesCanShareSubject(
  left: RecipeMatch,
  right: RecipeMatch,
  leftKind: RecipeTriggerKind = "push",
  rightKind: RecipeTriggerKind = "push",
): boolean {
  left = visibleScopeMatch(left);
  right = visibleScopeMatch(right);
  if (
    leftKind === "push" &&
    rightKind === "push" &&
    substringFiltersConflict(
      left.text_contains,
      left.text_excludes,
      right.text_contains,
      right.text_excludes,
    )
  ) {
    return false;
  }
  if (
    substringFiltersConflict(
      left.title_contains,
      left.title_excludes,
      right.title_contains,
      right.title_excludes,
    )
  ) {
    return false;
  }
  if (left.thread_id && right.thread_id && left.thread_id !== right.thread_id) {
    return false;
  }
  if (left.unit_kind && right.unit_kind && left.unit_kind !== right.unit_kind) {
    return false;
  }
  if (left.source && right.source && left.source !== right.source) {
    return false;
  }
  if (
    left.record_class &&
    right.record_class &&
    left.record_class !== right.record_class
  ) {
    return false;
  }
  if (
    left.thread_facet &&
    right.thread_facet &&
    left.thread_facet !== right.thread_facet
  ) {
    return false;
  }
  return true;
}

export function recipePreemptedBy(
  recipe: Recipe,
  recipes: readonly Recipe[],
): Recipe | undefined {
  if (!recipe.enabled) {
    return undefined;
  }
  return recipes.find(
    (other) =>
      other.id !== recipe.id &&
      other.enabled &&
      recipesCanShareSubject(recipe.match, other.match, recipe.trigger.kind, other.trigger.kind) &&
      recipeRanksBefore(other, recipe),
  );
}

function recipeRanksBefore(left: Recipe, right: Recipe): boolean {
  const bySpec = recipeSpecificity(left.match) - recipeSpecificity(right.match);
  if (bySpec !== 0) {
    return bySpec > 0;
  }
  return left.id < right.id;
}

export function matchRecipe(
  recipes: Recipe[],
  subject: RecipeSubject,
): Recipe | undefined {
  const hits = recipes
    .filter((recipe) => recipe.enabled && recipeMatches(recipe.match, subject, recipe.trigger.kind))
    .sort((left, right) => {
      const bySpec = recipeSpecificity(right.match) - recipeSpecificity(left.match);
      if (bySpec !== 0) {
        return bySpec;
      }
      return left.id < right.id ? -1 : 1;
    });
  return hits[0];
}
