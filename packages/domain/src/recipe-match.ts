import type { RecordClass } from "./record-class";
import type { ThreadFacet } from "./thread-facet";
import type { Recipe, RecipeMatch } from "./work";

export interface RecipeSubject {
  record_class: RecordClass;
  thread_facet: ThreadFacet;
  source: string;
  thread_id: string;
}

export function recipeSpecificity(match: RecipeMatch): number {
  let score = 0;
  if (match.thread_id) {
    score += 8;
  }
  if (match.source) {
    score += 4;
  }
  if (match.record_class) {
    score += 2;
  }
  if (match.thread_facet) {
    score += 1;
  }
  return score;
}

export function recipeMatches(match: RecipeMatch, subject: RecipeSubject): boolean {
  if (match.thread_id && match.thread_id !== subject.thread_id) {
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
  return true;
}

export function matchRecipe(
  recipes: Recipe[],
  subject: RecipeSubject,
): Recipe | undefined {
  const hits = recipes
    .filter((recipe) => recipe.enabled && recipeMatches(recipe.match, subject))
    .sort((left, right) => {
      const bySpec = recipeSpecificity(right.match) - recipeSpecificity(left.match);
      if (bySpec !== 0) {
        return bySpec;
      }
      return left.id < right.id ? -1 : 1;
    });
  return hits[0];
}
