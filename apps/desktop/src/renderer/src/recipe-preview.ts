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

type TriggerKind = "push" | "pull" | "manual";

function triggerKindOf(recipe: { trigger?: { kind?: TriggerKind } | null }): TriggerKind {
  return recipe.trigger?.kind ?? "push";
}

/**
 * Mirrors @regenic/domain recipeAllowsBind: only push/manual rules compete for a
 * chat. Scheduled (pull) rules run on their own clock and never preempt.
 */
export function competesForChat(kind: TriggerKind): boolean {
  return kind === "push" || kind === "manual";
}

/** Same order as selectRecipeForSubject: specificity, then push before manual, then id. */
export function recipeOutranks(
  left: { id: string; match: RecipeMatch; trigger?: { kind?: TriggerKind } | null },
  right: { id: string; match: RecipeMatch; trigger?: { kind?: TriggerKind } | null },
): boolean {
  const bySpec = recipeSpecificity(left.match) - recipeSpecificity(right.match);
  if (bySpec !== 0) {
    return bySpec > 0;
  }
  const leftPush = triggerKindOf(left) === "push" ? 1 : 0;
  const rightPush = triggerKindOf(right) === "push" ? 1 : 0;
  if (leftPush !== rightPush) {
    return leftPush > rightPush;
  }
  return left.id < right.id;
}

export function recipesCanShareSubject(left: RecipeMatch, right: RecipeMatch): boolean {
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

export function previewRecipeMatch(input: {
  match: RecipeMatch;
  draftId?: string;
  triggerKind?: TriggerKind;
  conversations: RecipeConversationOption[];
  recipes: RecipeView[];
  sampleLimit?: number;
}): RecipeMatchPreview {
  const sampleLimit = input.sampleLimit ?? 3;
  const hits = matchingConversations(input.match, input.conversations);
  if (!hits) {
    return { ready: false, count: 0, samples: [], sample_ids: [] };
  }

  const triggerKind = input.triggerKind ?? "push";
  const draftFace = {
    id: input.draftId ?? "~draft",
    match: input.match,
    trigger: { kind: triggerKind },
  };
  const preempted = competesForChat(triggerKind)
    ? input.recipes.find(
        (other) =>
          other.id !== input.draftId &&
          other.enabled &&
          competesForChat(triggerKindOf(other)) &&
          recipesCanShareSubject(input.match, other.match) &&
          recipeOutranks(other, draftFace),
      )
    : undefined;

  const limited = hits.slice(0, sampleLimit);
  return {
    ready: true,
    count: hits.length,
    samples: limited.map((item) => item.label),
    sample_ids: limited.map((item) => item.id),
    ...(preempted ? { preempted_by: preempted.name } : {}),
  };
}

/** Every known chat the match covers; null when the match is not usable yet. */
export function matchingConversations(
  match: RecipeMatch,
  conversations: RecipeConversationOption[],
): RecipeConversationOption[] | null {
  if (recipeSpecificity(match) === 0) {
    return null;
  }
  if (match.thread_id !== undefined && !match.thread_id.trim()) {
    return null;
  }
  if (match.source !== undefined && !match.source.trim()) {
    return null;
  }
  return conversations.filter((conversation) => {
    const subject = subjectFromConversation(conversation);
    return subject ? recipeMatches(match, subject) : false;
  });
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

type PriorityMember = Pick<RecipeView, "id" | "name" | "match" | "enabled"> & {
  trigger?: { kind?: TriggerKind } | null;
};

/**
 * Overlapping rules that compete for the same chat, ordered so rank 1 wins.
 * Empty when alone, and for scheduled rules (they never compete).
 */
export function overlappingPriorityGroup(
  focus: PriorityMember,
  recipes: readonly RecipeView[],
): RecipePriorityRow[] {
  if (!competesForChat(triggerKindOf(focus))) {
    return [];
  }
  const members = new Map<string, PriorityMember>();
  members.set(focus.id, focus);
  for (const recipe of recipes) {
    if (recipe.id === focus.id) {
      continue;
    }
    if (
      competesForChat(triggerKindOf(recipe)) &&
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
    return recipeOutranks(left, right) ? -1 : 1;
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
