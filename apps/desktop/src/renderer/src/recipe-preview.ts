import type {
  RecipeConversationOption,
  RecipeMatch,
  RecipeView,
  RecordClass,
  ThreadFacet,
} from "./types";

/** Keep weights aligned with @regenic/domain recipe-match. */
const WEIGHTS = {
  thread_id: 16,
  unit_kind: 8,
  source: 4,
  record_class: 2,
  thread_facet: 1,
} as const;

export interface RecipePreviewSubject {
  record_class: RecordClass;
  thread_facet: ThreadFacet;
  source: string;
  thread_id: string;
  unit_kind?: string;
}

export interface RecipeMatchPreview {
  ready: boolean;
  count: number;
  samples: string[];
  sample_ids: string[];
  preempted_by?: string;
}

export function recipeSpecificity(match: RecipeMatch): number {
  let score = 0;
  if (match.thread_id) score += WEIGHTS.thread_id;
  if (match.unit_kind) score += WEIGHTS.unit_kind;
  if (match.source) score += WEIGHTS.source;
  if (match.record_class) score += WEIGHTS.record_class;
  if (match.thread_facet) score += WEIGHTS.thread_facet;
  return score;
}

export function recipeMatches(match: RecipeMatch, subject: RecipePreviewSubject): boolean {
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
  return true;
}

export function subjectFromConversation(
  conversation: RecipeConversationOption,
): RecipePreviewSubject | null {
  const thread_id = conversation.id.trim();
  const source = (conversation.source ?? "").trim();
  if (!thread_id || !source) {
    return null;
  }
  const record_class =
    conversation.record_class ??
    (conversation.has_work ? "task" : "utterance");
  const thread_facet =
    conversation.thread_facet ??
    (record_class === "task" ? "ticket" : "chat");
  return {
    record_class,
    thread_facet,
    source,
    thread_id,
    ...(conversation.unit_kind?.trim()
      ? { unit_kind: conversation.unit_kind.trim() }
      : {}),
  };
}

function recipesCanShareSubject(left: RecipeMatch, right: RecipeMatch): boolean {
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

function recipeRanksBefore(left: RecipeView, right: { id: string; match: RecipeMatch }): boolean {
  const bySpec = recipeSpecificity(left.match) - recipeSpecificity(right.match);
  if (bySpec !== 0) {
    return bySpec > 0;
  }
  return left.id < right.id;
}

export function previewRecipeMatch(input: {
  match: RecipeMatch;
  draftId?: string;
  conversations: RecipeConversationOption[];
  recipes: RecipeView[];
  sampleLimit?: number;
}): RecipeMatchPreview {
  const sampleLimit = input.sampleLimit ?? 3;
  if (recipeSpecificity(input.match) === 0) {
    return { ready: false, count: 0, samples: [], sample_ids: [] };
  }
  if (input.match.thread_id && !input.match.thread_id.trim()) {
    return { ready: false, count: 0, samples: [], sample_ids: [] };
  }
  if (input.match.source !== undefined && !input.match.source.trim()) {
    return { ready: false, count: 0, samples: [], sample_ids: [] };
  }

  const hits: RecipeConversationOption[] = [];
  for (const conversation of input.conversations) {
    const subject = subjectFromConversation(conversation);
    if (!subject) {
      continue;
    }
    if (recipeMatches(input.match, subject)) {
      hits.push(conversation);
    }
  }

  const draftFace = {
    id: input.draftId ?? "~draft",
    match: input.match,
  };
  const preempted = input.recipes.find(
    (other) =>
      other.id !== input.draftId &&
      other.enabled &&
      recipesCanShareSubject(input.match, other.match) &&
      recipeRanksBefore(other, draftFace),
  );

  const limited = hits.slice(0, sampleLimit);
  return {
    ready: true,
    count: hits.length,
    samples: limited.map((item) => item.label),
    sample_ids: limited.map((item) => item.id),
    ...(preempted ? { preempted_by: preempted.name } : {}),
  };
}

/** Broad or high-blast saves should confirm with the match preview first. */
export function shouldConfirmRecipeSave(input: {
  isNew: boolean;
  triggerKind: "push" | "pull" | "manual";
  scope: "tasks" | "source" | "thread";
  canWriteBack: boolean;
  preview: RecipeMatchPreview;
}): boolean {
  if (input.triggerKind === "manual") {
    return false;
  }
  if (input.scope === "tasks") {
    return true;
  }
  if (input.preview.ready && input.preview.count >= 3) {
    return true;
  }
  if (
    input.isNew &&
    input.canWriteBack &&
    input.triggerKind === "push" &&
    input.scope === "source"
  ) {
    return true;
  }
  return false;
}

export interface RecipePriorityRow {
  id: string;
  name: string;
  specificity: number;
  rank: number;
  enabled: boolean;
  is_self: boolean;
}

/** Overlapping recipes ordered so rank 1 wins first. Empty when alone. */
export function overlappingPriorityGroup(
  focus: Pick<RecipeView, "id" | "name" | "match" | "enabled">,
  recipes: readonly RecipeView[],
): RecipePriorityRow[] {
  const members = new Map<string, Pick<RecipeView, "id" | "name" | "match" | "enabled">>();
  members.set(focus.id, focus);
  for (const recipe of recipes) {
    if (
      recipe.id === focus.id ||
      recipesCanShareSubject(focus.match, recipe.match)
    ) {
      members.set(recipe.id, recipe);
    }
  }
  if (members.size <= 1) {
    return [];
  }
  const sorted = [...members.values()].sort((left, right) => {
    const bySpec =
      recipeSpecificity(right.match) - recipeSpecificity(left.match);
    if (bySpec !== 0) {
      return bySpec;
    }
    if (left.enabled !== right.enabled) {
      return left.enabled ? -1 : 1;
    }
    return left.id < right.id ? -1 : 1;
  });
  let rank = 0;
  return sorted.map((recipe) => {
    if (recipe.enabled) {
      rank += 1;
    }
    return {
      id: recipe.id,
      name: recipe.name,
      specificity: recipeSpecificity(recipe.match),
      rank: recipe.enabled ? rank : 0,
      enabled: recipe.enabled,
      is_self: recipe.id === focus.id,
    };
  });
}

export function tryOnceThreadId(input: {
  matchThreadId?: string;
  preview: RecipeMatchPreview;
}): string | null {
  const bound = input.matchThreadId?.trim();
  if (bound) {
    return bound;
  }
  if (!input.preview.ready || input.preview.count !== 1) {
    return null;
  }
  return input.preview.sample_ids[0]?.trim() || null;
}
