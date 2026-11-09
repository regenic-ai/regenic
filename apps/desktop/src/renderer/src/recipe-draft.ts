import { formatNextRunWhen, formatTime } from "./format.ts";
import { configForRecipeEdit, configFromCatalog } from "./recipe-params.ts";
import {
  competesForChat,
  matchingConversations,
  previewRecipeMatch,
  recipeOutranks,
  recipesCanShareSubject,
} from "./recipe-preview.ts";
import {
  DEFAULT_AT_MINUTE,
  DEFAULT_WEEKDAYS,
  localTimeZone,
  modeFromTrigger,
  pullTriggerFromDraft,
  scheduleCopy,
  type ScheduleMode,
} from "./schedule.ts";
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
      schedule_mode: draft.schedule_mode,
      at_minute: draft.at_minute,
      weekdays: draft.weekdays.length ? draft.weekdays : [...DEFAULT_WEEKDAYS],
      timezone: draft.timezone || localTimeZone(),
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
  schedule_mode: ScheduleMode;
  at_minute: number;
  weekdays: number[];
  timezone: string;
  coalesce: boolean;
  scope: RecipeScope;
  source: string;
  thread_id: string;
  thread_title: string;
  thread_facet: ThreadFacet | "";
  unit_kind: string;
  text_contains: string;
  text_excludes: string;
  executor_type: string;
  config: Record<string, string>;
  can_write_back: boolean;
  write_back_thread_id: string;
  include_context: boolean;
  max_concurrent: string;
  enabled: boolean;
  /** Saved match when editing, so fields the form does not show survive a save. */
  base_match?: RecipeMatch;
  base_scope?: RecipeScope;
  base_pull?: boolean;
}

export type StarterKind = "chat" | "channel" | "schedule";

export function emptyDraft(executorType = ""): RecipeDraft {
  return {
    name: "",
    nameTouched: false,
    trigger_kind: "push",
    interval_ms: 60 * 60 * 1000,
    schedule_mode: "interval",
    at_minute: DEFAULT_AT_MINUTE,
    weekdays: [...DEFAULT_WEEKDAYS],
    timezone: localTimeZone(),
    coalesce: true,
    scope: "thread",
    source: "",
    thread_id: "",
    thread_title: "",
    thread_facet: "",
    unit_kind: "",
    text_contains: "",
    text_excludes: "",
    executor_type: executorType,
    config: {},
    can_write_back: true,
    write_back_thread_id: "",
    include_context: true,
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
      include_context: true,
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
    include_context: true,
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
  conversations: RecipeConversationOption[] = [],
): RecipeDraft {
  const config: Record<string, string> = {};
  for (const [key, value] of Object.entries(recipe.executor_config ?? {})) {
    if (typeof value === "string") {
      config[key] = value;
    }
  }
  const scope: RecipeScope = recipe.match.thread_id
    ? "thread"
    : recipe.match.source
      ? "source"
      : "tasks";
  return {
    id: recipe.id,
    name: recipe.name,
    nameTouched: true,
    trigger_kind: recipe.trigger?.kind ?? "push",
    interval_ms: recipe.trigger?.interval_ms ?? 60 * 60 * 1000,
    schedule_mode: modeFromTrigger(recipe.trigger),
    at_minute: recipe.trigger?.at_minute ?? DEFAULT_AT_MINUTE,
    weekdays: recipe.trigger?.weekdays?.length
      ? [...recipe.trigger.weekdays]
      : [...DEFAULT_WEEKDAYS],
    timezone: recipe.trigger?.timezone || localTimeZone(),
    coalesce: recipe.trigger?.coalesce !== false,
    scope,
    source: recipe.match.source ?? "",
    thread_id: recipe.match.thread_id ?? "",
    thread_title:
      conversations.find((item) => item.id === recipe.match.thread_id)?.label ??
      recipe.match.thread_id ??
      "",
    thread_facet: recipe.match.thread_facet ?? "",
    unit_kind: recipe.match.unit_kind ?? "",
    text_contains: recipe.match.text_contains ?? "",
    text_excludes: recipe.match.text_excludes ?? "",
    executor_type: recipe.executor_type,
    config: configForRecipeEdit(catalog, config),
    can_write_back: recipe.can_write_back,
    write_back_thread_id: recipe.write_back_thread_id ?? "",
    include_context: recipe.include_context,
    max_concurrent:
      recipe.max_concurrent && recipe.max_concurrent > 0
        ? String(recipe.max_concurrent)
        : "",
    enabled: recipe.enabled,
    base_match: { ...recipe.match },
    base_scope: scope,
    base_pull: recipe.trigger?.kind === "pull",
  };
}

/** Saved match fields the form does not edit, kept while scope and trigger family stay put. */
function hiddenMatch(draft: RecipeDraft): RecipeMatch | null {
  const base = draft.base_match;
  if (
    !base ||
    draft.scope !== draft.base_scope ||
    (draft.trigger_kind === "pull") !== Boolean(draft.base_pull)
  ) {
    return null;
  }
  if (draft.trigger_kind === "pull" || draft.scope === "thread") {
    return {
      ...(base.source ? { source: base.source } : {}),
      ...(base.record_class ? { record_class: base.record_class } : {}),
      ...(base.unit_kind ? { unit_kind: base.unit_kind } : {}),
    };
  }
  return base.record_class ? { record_class: base.record_class } : {};
}

export function draftMatch(draft: RecipeDraft): RecipeMatch {
  return {
    ...draftScopeMatch(draft),
    ...(draft.text_contains.trim() ? { text_contains: draft.text_contains } : {}),
    ...(draft.text_excludes.trim() ? { text_excludes: draft.text_excludes } : {}),
  };
}

function draftScopeMatch(draft: RecipeDraft): RecipeMatch {
  const hidden = hiddenMatch(draft);
  if (draft.trigger_kind === "pull") {
    return {
      ...hidden,
      ...(draft.thread_id.trim() ? { thread_id: draft.thread_id.trim() } : {}),
      ...(draft.thread_facet ? { thread_facet: draft.thread_facet } : {}),
    };
  }
  if (draft.scope === "source" && !draft.source.trim()) {
    return {};
  }
  if (draft.scope === "thread") {
    return {
      ...hidden,
      thread_id: draft.thread_id.trim(),
      ...(draft.thread_facet ? { thread_facet: draft.thread_facet } : {}),
    };
  }
  const unitKind = draft.unit_kind.trim();
  const recordClass = hidden
    ? (hidden.record_class ?? (unitKind ? undefined : "task"))
    : "task";
  return {
    ...(recordClass ? { record_class: recordClass } : {}),
    ...(draft.scope === "source" && draft.source.trim()
      ? { source: draft.source.trim() }
      : {}),
    ...(draft.thread_facet ? { thread_facet: draft.thread_facet } : {}),
    ...(unitKind ? { unit_kind: unitKind } : {}),
  };
}

export function draftTrigger(draft: RecipeDraft): RecipeView["trigger"] {
  if (draft.trigger_kind === "pull") {
    return pullTriggerFromDraft(draft);
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

export function recipeCardLine(
  recipe: RecipeView,
  sources: RecipeSourceOption[],
  conversations: RecipeConversationOption[],
  executor: string,
  t: Translate,
): string {
  const outcome = recipe.can_write_back
    ? t("recipes.outcomeBack")
    : t("recipes.outcomeKeep");
  const concurrent =
    recipe.max_concurrent && recipe.max_concurrent > 0
      ? t("recipes.outcomeConcurrent", { count: String(recipe.max_concurrent) })
      : "";
  return t("recipes.cardLine", {
    when: whenCopy(recipe, sources, conversations, t),
    executor,
    outcome: [
      `${outcome}${concurrent}`,
      ...((recipe.trigger?.kind ?? "push") === "push" ? [
       ...(recipe.match.text_contains ? [t("recipes.filterContainsSummary", { text: recipe.match.text_contains })] : []),
       ...(recipe.match.text_excludes ? [t("recipes.filterExcludesSummary", { text: recipe.match.text_excludes })] : []),
      ] : []),
    ].join(" · "),
  });
}

export function writeBackAvailable(
  draft: RecipeDraft,
  conversations: RecipeConversationOption[],
  sampleThreadId?: string,
): boolean {
  const destination =
    draft.write_back_thread_id || sampleThreadId || draftMatch(draft).thread_id;
  if (destination) {
    return conversations.some((item) => item.id === destination && item.can_send === true);
  }
  return (matchingConversations(draftMatch(draft), conversations, draft.trigger_kind) ?? [])
    .some((item) => item.can_send === true);
}

export function writeBackChoices(
  draft: RecipeDraft,
  conversations: RecipeConversationOption[],
  t: Translate,
): Array<{ value: string; label: string }> {
  return [
    ...(writeBackAvailable({ ...draft, write_back_thread_id: "" }, conversations)
      ? [{ value: "", label: t("recipes.writeBackOriginal") }]
      : []),
    ...conversations.filter((item) => item.can_send === true)
      .map((item) => ({ value: item.id, label: item.label })),
  ];
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
  if (!recipe.enabled || !competesForChat(recipe.trigger?.kind ?? "push")) {
    return null;
  }
  const other = recipes.find(
    (item) =>
      item.id !== recipe.id &&
      item.enabled &&
      competesForChat(item.trigger?.kind ?? "push") &&
      recipesCanShareSubject(recipe.match, item.match, recipe.trigger?.kind ?? "push", item.trigger?.kind ?? "push") &&
      recipeOutranks(item, recipe),
  );
  if (!other) {
    return null;
  }
  return t("recipes.losesTo", { name: other.name });
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
      interval: scheduleCopy(recipe.trigger, t),
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
