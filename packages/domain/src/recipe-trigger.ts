import type { Specification } from "./specification";
import type { RecipeMatch } from "./work";

/**
 * Recipe as a launchd/systemd unit: the trigger must be specific.
 * Facet and source-only matches are device capabilities, not On=.
 */
export class RecipeAutoStartSpec implements Specification<RecipeMatch> {
  isSatisfiedBy(match: RecipeMatch): boolean {
    if (match.thread_id?.trim()) {
      return true;
    }
    if (match.record_class === "task") {
      return true;
    }
    if (
      match.source?.trim() &&
      match.record_class &&
      match.record_class !== "utterance"
    ) {
      return true;
    }
    return false;
  }
}

export const recipeAutoStartSpec = new RecipeAutoStartSpec();

export function recipeAllowsAutoStart(match: RecipeMatch): boolean {
  return recipeAutoStartSpec.isSatisfiedBy(match);
}
