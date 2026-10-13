import { formatNextRunWhen, formatTime } from "./format";
import { configFromCatalog } from "./recipe-params";
import { previewRecipeMatch } from "./recipe-preview";
import type { MessageKey } from "../../shared/i18n.ts";
import type {
  ExecutorCatalogEntry,
  RecipeConversationOption,
  RecipeLastRun,
  RecipeMatch,
  RecipeSeed,
  RecipeSourceOption,
  RecipeTriggerKind,
  RecipeView,
  ThreadFacet,
} from "./types";

export const PULL_INTERVALS = [
  { ms: 15 * 60 * 1000, label: "recipes.interval15m" as const },
  { ms: 60 * 60 * 1000, label: "recipes.interval1h" as const },
  { ms: 24 * 60 * 60 * 1000, label: "recipes.interval1d" as const },
];

export type RecipeScope = "tasks" | "source" | "thread";

export type Translate = (
  key: MessageKey,
  vars?: Record<string, string | number>,
) => string;

export function saveCoverageCopy(
  preview: ReturnType<typeof previewRecipeMatch>,
  draft: RecipeDraft,
  t: Translate,
): string {
  if (!preview.ready) {
    if (draft.scope === "tasks") {
      return t("recipes.scopeTasks");
    }
    if (draft.scope === "source") {
      return t("recipes.scopeSource");
    }
    return t("recipes.scopeThread");
  }
  if (preview.count === 0) {
    return t("recipes.previewNone");
  }
  if (preview.count === 1) {
    return t("recipes.previewOne", { name: preview.samples[0] ?? "" });
  }
  return t("recipes.previewMany", { count: preview.count });
}

export function importErrorKey(code: string): MessageKey {
  if (code === "invalid_json") {
    return "recipes.importInvalidJson";
  }
  if (code === "unsupported_version") {
    return "recipes.importVersion";
  }
  if (code === "empty_recipes") {
    return "recipes.importEmpty";
  }
  if (code === "invalid_recipe") {
    return "recipes.importInvalidRecipe";
  }
  return "recipes.importError";
}

export function unitKindsForSource(
  sources: RecipeSourceOption[],
  sourceId: string,
): Array<{ id: string; label: string }> {
  return sources.find((item) => item.id === sourceId)?.unit_kinds ?? [];
}

export function scopeChoices(t: Translate): Array<{ id: RecipeScope; label: string }> {
  return [
    { id: "tasks", label: t("recipes.scopeTasks") },
    { id: "source", label: t("recipes.scopeSource") },
    { id: "thread", label: t("recipes.scopeThread") },
  ];
}

export function triggerChoices(
  t: Translate,
): Array<{ id: RecipeTriggerKind; label: string }> {
  return [
    { id: "push", label: t("recipes.triggerPush") },
    { id: "pull", label: t("recipes.triggerPull") },
    { id: "manual", label: t("recipes.triggerManual") },
  ];
}

export function triggerHint(kind: RecipeTriggerKind, t: Translate): string {
  if (kind === "pull") {
    return t("recipes.triggerPullHint");
  }
  if (kind === "manual") {
    return t("recipes.triggerManualHint");
  }
  return t("recipes.triggerPushHint");
}

export function applyTriggerKind(draft: RecipeDraft, kind: RecipeTriggerKind): RecipeDraft {
  if (kind === "pull") {
    return {
      ...draft,
      trigger_kind: "pull",
      scope: "thread",
      include_context: true,
      can_write_back: true,
      interval_ms: draft.interval_ms || 60 * 60 * 1000,
    };
  }
  return { ...draft, trigger_kind: kind };
}

export interface RecipeDraft {
  id?: string;
  name: string;
  nameTouched: boolean;
  trigger_kind: RecipeTriggerKind;
  interval_ms: number;
  coalesce: boolean;
  scope: RecipeScope;
  source: string;
  thread_id: string;
  thread_title: string;
  thread_facet: ThreadFacet | "";
  unit_kind: string;
  executor_type: string;
  config: Record<string, string>;
  can_write_back: boolean;
  include_context: boolean;
  max_concurrent: string;
  enabled: boolean;
}

export type StarterKind = "chat" | "channel" | "schedule";

export function emptyDraft(executorType = ""): RecipeDraft {
  return {
    name: "",
    nameTouched: false,
    trigger_kind: "push",
    interval_ms: 60 * 60 * 1000,
    coalesce: true,
    scope: "thread",
    source: "",
    thread_id: "",
    thread_title: "",
    thread_facet: "",
    unit_kind: "",
    executor_type: executorType,
    config: {},
    can_write_back: true,
    include_context: false,
    max_concurrent: "",
    enabled: true,
  };
}

export function emptyDraftFrom(
  executors: ExecutorCatalogEntry[],
  sources: RecipeSourceOption[] = [],
): RecipeDraft {
  const first = executors[0];
  const base = {
    ...emptyDraft(first?.executor_type ?? ""),
    config: configFromCatalog(first),
  };
  if (sources.length === 1) {
    return {
      ...base,
      source: sources[0].id,
      can_write_back: true,
    };
  }
  return base;
}

export function starterDraft(
  kind: StarterKind,
  base: RecipeDraft,
  sources: RecipeSourceOption[],
  conversations: RecipeConversationOption[],
): RecipeDraft {
  if (kind === "schedule") {
    const first = conversations[0];
    return applyTriggerKind(
      {
        ...base,
        scope: "thread",
        thread_id: first?.id ?? "",
        thread_title: first?.label ?? "",
        source: first?.source ?? base.source,
        can_write_back: first?.can_send !== false,
      },
      "pull",
    );
  }
  if (kind === "channel") {
    const source = sources[0];
    return {
      ...base,
      trigger_kind: "push",
      scope: "source",
      source: source?.id ?? "",
      thread_id: "",
      thread_title: "",
      can_write_back: true,
      include_context: false,
    };
  }
  const first = conversations[0];
  return {
    ...base,
    trigger_kind: "push",
    scope: "thread",
    thread_id: first?.id ?? "",
    thread_title: first?.label ?? "",
    source: first?.source ?? base.source,
    can_write_back: first?.can_send !== false,
    include_context: false,
  };
}

export function withCatalogDefaults(
  draft: RecipeDraft,
  executors: ExecutorCatalogEntry[],
): RecipeDraft {
  const executor_type = draft.executor_type || executors[0]?.executor_type || "";
  const catalog = executors.find((item) => item.executor_type === executor_type);
  const hasInvoke = Object.values(draft.config).some((value) => value.trim());
  return {
    ...draft,
    executor_type,
    config: hasInvoke ? draft.config : configFromCatalog(catalog, draft.config),
  };
}

export function applySeed(
  current: RecipeDraft,
  seed: RecipeSeed,
  executorType: string,
): RecipeDraft {
  return withSuggestedName({
    ...emptyDraft(executorType || current.executor_type),
    scope: "thread",
    source: seed.source ?? "",
    thread_id: seed.thread_id,
    thread_title: seed.title?.trim() || seed.thread_id,
    config: current.config,
  });
}

export function draftFromRecipe(
  recipe: RecipeView,
  catalog?: ExecutorCatalogEntry,
): RecipeDraft {
  const config: Record<string, string> = {};
  for (const [key, value] of Object.entries(recipe.executor_config ?? {})) {
    if (typeof value === "string") {
      config[key] = value;
    }
  }
  return {
    id: recipe.id,
    name: recipe.name,
    nameTouched: true,
    trigger_kind: recipe.trigger?.kind ?? "push",
    interval_ms: recipe.trigger?.interval_ms ?? 60 * 60 * 1000,
    coalesce: recipe.trigger?.coalesce !== false,
    scope: recipe.match.thread_id
      ? "thread"
      : recipe.match.source
        ? "source"
        : "tasks",
    source: recipe.match.source ?? "",
    thread_id: recipe.match.thread_id ?? "",
    thread_title: recipe.match.thread_id ?? "",
    thread_facet: recipe.match.thread_facet ?? "",
    unit_kind: recipe.match.unit_kind ?? "",
    executor_type: recipe.executor_type,
    config: configFromCatalog(catalog, config),
    can_write_back: recipe.can_write_back,
    include_context: recipe.include_context,
    max_concurrent:
      recipe.max_concurrent && recipe.max_concurrent > 0
        ? String(recipe.max_concurrent)
        : "",
    enabled: recipe.enabled,
  };
}

export function draftMatch(draft: RecipeDraft): RecipeMatch {
  if (draft.trigger_kind === "pull") {
    return {
      ...(draft.thread_id.trim() ? { thread_id: draft.thread_id.trim() } : {}),
      ...(draft.thread_facet ? { thread_facet: draft.thread_facet } : {}),
    };
  }
  return {
    ...(draft.scope === "thread"
      ? { thread_id: draft.thread_id.trim() }
      : { record_class: "task" }),
    ...(draft.scope === "source" && draft.source.trim()
      ? { source: draft.source.trim() }
      : {}),
    ...(draft.thread_facet ? { thread_facet: draft.thread_facet } : {}),
    ...(draft.scope !== "thread" && draft.unit_kind.trim()
      ? { unit_kind: draft.unit_kind.trim() }
      : {}),
  };
}

export function draftTrigger(draft: RecipeDraft): RecipeView["trigger"] {
  if (draft.trigger_kind === "pull") {
    return { kind: "pull", interval_ms: draft.interval_ms };
  }
  if (draft.trigger_kind === "manual") {
    return { kind: "manual" };
  }
  return { kind: "push", coalesce: draft.coalesce };
}

export function canAutoStart(match: RecipeMatch, draft: RecipeDraft): boolean {
  if (draft.trigger_kind === "pull") {
    return Boolean(match.thread_id && draft.interval_ms);
  }
  return Boolean(
    match.thread_id ||
      match.unit_kind ||
      match.record_class === "task" ||
      (match.source && match.record_class && match.record_class !== "utterance"),
  );
}

export function scopeError(draft: RecipeDraft, t: Translate): string {
  if (draft.trigger_kind === "pull") {
    if (!draft.thread_id.trim()) {
      return t("recipes.errPullThread");
    }
    return t("recipes.errInterval");
  }
  if (draft.scope === "thread") {
    return t("recipes.errThread");
  }
  if (draft.scope === "source" && !draft.source.trim()) {
    return t("recipes.errSource");
  }
  return t("recipes.errScope");
}

export function withSuggestedName(draft: RecipeDraft): RecipeDraft {
  if (draft.nameTouched) {
    return draft;
  }
  return { ...draft, name: "" };
}

export function suggestedRecipeName(
  draft: RecipeDraft,
  sources: RecipeSourceOption[],
  catalog: ExecutorCatalogEntry | undefined,
  t: Translate,
): string {
  const executor = catalog?.label ?? t("recipes.executorFallback");
  if (draft.trigger_kind === "pull") {
    const title = draft.thread_title.trim() || t("recipes.thisConversation");
    return t("recipes.suggestedPull", { title, executor });
  }
  if (draft.trigger_kind === "manual" && draft.scope === "thread") {
    const title = draft.thread_title.trim() || t("recipes.thisConversation");
    return t("recipes.suggestedManual", { title, executor });
  }
  if (draft.scope === "thread") {
    const title = draft.thread_title.trim() || t("recipes.thisConversation");
    return t("recipes.suggestedThread", { title, executor });
  }
  if (draft.scope === "source") {
    const source =
      sources.find((item) => item.id === draft.source)?.label ??
      t("recipes.sourceFallback");
    if (draft.unit_kind.trim()) {
      return t("recipes.suggestedUnitKind", {
        source,
        kind: unitKindLabel(sources, draft.unit_kind) ?? draft.unit_kind,
        executor,
      });
    }
    return t("recipes.suggestedSource", { source, executor });
  }
  if (draft.unit_kind.trim()) {
    return t("recipes.suggestedUnitKind", {
      source: t("recipes.whenAll"),
      kind: unitKindLabel(sources, draft.unit_kind) ?? draft.unit_kind,
      executor,
    });
  }
  return t("recipes.suggestedTasks", { executor });
}

function unitKindLabel(
  sources: RecipeSourceOption[],
  unitKind: string,
): string | undefined {
  for (const source of sources) {
    const found = source.unit_kinds?.find((item) => item.id === unitKind);
    if (found) {
      return found.label;
    }
  }
  return undefined;
}

export function parseMaxConcurrent(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 1) {
    return null;
  }
  return Math.min(Math.floor(n), 1_000);
}

export function formTitle(
  draft: RecipeDraft,
  returnToWork: boolean,
  t: Translate,
): string {
  if (draft.id) {
    return t("recipes.formEdit");
  }
  if (returnToWork) {
    return t("recipes.formBind");
  }
  return t("recipes.formNew");
}

export function conversationChoices(
  conversations: RecipeConversationOption[],
  draft: Pick<RecipeDraft, "thread_id" | "thread_title">,
): Array<RecipeConversationOption & { value: string }> {
  const options = conversations.map((item) => ({
    ...item,
    value: item.id,
  }));
  if (draft.thread_id && !options.some((item) => item.id === draft.thread_id)) {
    options.unshift({
      id: draft.thread_id,
      value: draft.thread_id,
      label: draft.thread_title || draft.thread_id,
    });
  }
  return options;
}

function intervalCopy(intervalMs: number | undefined, t: Translate): string {
  const found = PULL_INTERVALS.find((item) => item.ms === intervalMs);
  return found ? t(found.label) : t("recipes.triggerPull");
}

export function recipeCardLine(
  recipe: RecipeView,
  sources: RecipeSourceOption[],
  conversations: RecipeConversationOption[],
  executor: string,
  t: Translate,
): string {
  const outcome = recipe.can_write_back
    ? t("recipes.outcomeBack")
    : recipe.trigger?.kind === "pull"
      ? t("recipes.outcomeKeep")
      : "";
  const concurrent =
    recipe.max_concurrent && recipe.max_concurrent > 0
      ? t("recipes.outcomeConcurrent", { count: String(recipe.max_concurrent) })
      : "";
  return t("recipes.cardLine", {
    when: whenCopy(recipe, sources, conversations, t),
    executor,
    outcome: `${outcome}${concurrent}`,
  });
}

export function writeBackAvailable(
  draft: Pick<RecipeDraft, "thread_id">,
  conversations: RecipeConversationOption[],
): boolean {
  const picked = conversations.find((item) => item.id === draft.thread_id);
  return picked?.can_send !== false;
}

export function runStatusCopy(status: string, t: Translate): string | null {
  if (status === "failed") {
    return t("recipes.lastRunFailed");
  }
  if (status === "completed") {
    return t("recipes.lastRunDone");
  }
  if (status === "cancelled") {
    return t("recipes.lastRunSkipped");
  }
  if (status === "running" || status === "waiting_human") {
    return t("recipes.lastRunRunning");
  }
  return null;
}

function runLineCopy(run: RecipeLastRun, t: Translate): string {
  const status = runStatusCopy(run.status, t) ?? run.status;
  return t("recipes.lastRunAt", { status, when: formatTime(run.at) });
}

export function lastRunCopy(recipe: RecipeView, t: Translate): string | null {
  const run = recipe.last_run;
  if (!run) {
    return null;
  }
  if (!runStatusCopy(run.status, t)) {
    return null;
  }
  return runLineCopy(run, t);
}

export function conflictCopy(
  recipe: RecipeView,
  recipes: RecipeView[],
  t: Translate,
): string | null {
  if (!recipe.enabled) {
    return null;
  }
  const other = recipes.find(
    (item) =>
      item.id !== recipe.id &&
      item.enabled &&
      recipesOverlap(recipe.match, item.match) &&
      recipeRanksBefore(item, recipe),
  );
  if (!other) {
    return null;
  }
  return t("recipes.losesTo", { name: other.name });
}

function recipesOverlap(
  left: RecipeMatch,
  right: RecipeMatch,
): boolean {
  if (left.thread_id && right.thread_id && left.thread_id !== right.thread_id) {
    return false;
  }
  if (left.source && right.source && left.source !== right.source) {
    return false;
  }
  if (left.unit_kind && right.unit_kind && left.unit_kind !== right.unit_kind) {
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

function recipeRanksBefore(left: RecipeView, right: RecipeView): boolean {
  const leftScore = matchScore(left.match);
  const rightScore = matchScore(right.match);
  if (leftScore !== rightScore) {
    return leftScore > rightScore;
  }
  return left.id < right.id;
}

function matchScore(match: RecipeMatch): number {
  return (
    (match.thread_id ? 16 : 0) +
    (match.unit_kind ? 8 : 0) +
    (match.source ? 4 : 0) +
    (match.record_class ? 2 : 0) +
    (match.thread_facet ? 1 : 0)
  );
}

export function nextRunCopy(recipe: RecipeView, t: Translate): string | null {
  if ((recipe.trigger?.kind ?? "push") !== "pull") {
    return null;
  }
  const next = formatNextRunWhen(recipe.next_run_at);
  if (next === "due") {
    return t("recipes.nextRunDue");
  }
  if (next) {
    return t("recipes.nextRun", { when: next });
  }
  return null;
}

function whenCopy(
  recipe: RecipeView,
  sources: RecipeSourceOption[],
  conversations: RecipeConversationOption[],
  t: Translate,
): string {
  const kind = recipe.trigger?.kind ?? "push";
  const matchWhen = matchWhenCopy(recipe, sources, conversations, t);
  if (kind === "pull") {
    const title =
      conversations.find((item) => item.id === recipe.match.thread_id)?.label ??
      (recipe.match.thread_id ? shortThread(recipe.match.thread_id) : t("recipes.thisConversation"));
    return t("recipes.whenPull", {
      interval: intervalCopy(recipe.trigger?.interval_ms, t),
      thread: title,
    });
  }
  if (kind === "manual") {
    return t("recipes.whenManual", { when: matchWhen });
  }
  if (recipe.match.thread_id) {
    return t("recipes.whenPush", { when: matchWhen });
  }
  return t("recipes.whenPush", { when: matchWhen });
}

function matchWhenCopy(
  recipe: RecipeView,
  sources: RecipeSourceOption[],
  conversations: RecipeConversationOption[],
  t: Translate,
): string {
  if (recipe.match.thread_id) {
    const title =
      conversations.find((item) => item.id === recipe.match.thread_id)?.label ??
      shortThread(recipe.match.thread_id);
    return t("recipes.whenOnly", { thread: title });
  }
  const sourceLabel = recipe.match.source
    ? (sources.find((item) => item.id === recipe.match.source)?.label ??
      recipe.match.source)
    : null;
  const kindLabel = recipe.match.unit_kind
    ? (unitKindLabel(sources, recipe.match.unit_kind) ?? recipe.match.unit_kind)
    : null;
  const facet =
    recipe.match.thread_facet === "ticket"
      ? t("recipes.facetTickets")
      : recipe.match.thread_facet === "agent"
        ? t("recipes.facetAgents")
        : recipe.match.thread_facet === "chat"
          ? t("recipes.facetChats")
          : null;
  if (kindLabel && sourceLabel) {
    return t("recipes.whenSourceUnitKind", { source: sourceLabel, kind: kindLabel });
  }
  if (kindLabel) {
    return t("recipes.whenUnitKind", { kind: kindLabel });
  }
  if (recipe.match.record_class === "task" && sourceLabel && facet) {
    return t("recipes.whenSourceFacet", { source: sourceLabel, facet });
  }
  if (recipe.match.record_class === "task" && sourceLabel) {
    return t("recipes.whenSource", { source: sourceLabel });
  }
  if (recipe.match.record_class === "task" && facet) {
    return t("recipes.whenFacet", { facet });
  }
  if (recipe.match.record_class === "task") {
    return t("recipes.whenAll");
  }
  const bits = [
    sourceLabel,
    recipe.match.record_class,
    recipe.match.thread_facet,
  ].filter(Boolean);
  return bits.length > 0 ? bits.join(" · ") : t("recipes.whenNone");
}

function shortThread(threadId: string): string {
  const cut = threadId.lastIndexOf(":");
  const tail = cut >= 0 ? threadId.slice(cut + 1) : threadId;
  return tail.length > 36 ? `${tail.slice(0, 34)}…` : tail;
}
