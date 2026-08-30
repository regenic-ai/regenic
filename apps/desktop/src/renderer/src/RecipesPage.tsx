import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import {
  deleteRecipe,
  fetchExecutors,
  fetchRecipes,
  saveRecipe,
} from "./api";
import { formatNextRunWhen } from "./format";
import { useLocale } from "./LocaleContext";
import { MenuSelect } from "./MenuSelect";
import { RecipeParams } from "./RecipeParams";
import { configFromCatalog, invokeCopy, missingRequiredField } from "./recipe-params";
import type { MessageKey } from "../../shared/i18n.ts";
import type {
  ExecutorCatalogEntry,
  RecipeConversationOption,
  RecipeMatch,
  RecipeSeed,
  RecipeSourceOption,
  RecipeTriggerKind,
  RecipeView,
  ThreadFacet,
} from "./types";

const PULL_INTERVALS = [
  { ms: 15 * 60 * 1000, label: "recipes.interval15m" as const },
  { ms: 60 * 60 * 1000, label: "recipes.interval1h" as const },
  { ms: 24 * 60 * 60 * 1000, label: "recipes.interval1d" as const },
];

type RecipeScope = "tasks" | "source" | "thread";

export function RecipesPage({
  sources,
  conversations = [],
  seed,
  onSeedConsumed,
  onBound,
}: {
  sources: RecipeSourceOption[];
  conversations?: RecipeConversationOption[];
  seed?: RecipeSeed | null;
  onSeedConsumed?: () => void;
  onBound?: () => void;
}) {
  const { t, locale } = useLocale();
  const formRef = useRef<HTMLElement>(null);
  const [recipes, setRecipes] = useState<RecipeView[]>([]);
  const [executors, setExecutors] = useState<ExecutorCatalogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [returnToWork, setReturnToWork] = useState(() => Boolean(seed));
  const [draft, setDraft] = useState<RecipeDraft>(() =>
    seed ? applySeed(emptyDraft(), seed, "") : emptyDraft(),
  );

  const reload = async () => {
    const [nextRecipes, nextExecutors] = await Promise.all([
      fetchRecipes(),
      fetchExecutors(),
    ]);
    setRecipes(nextRecipes);
    setExecutors(nextExecutors);
    setDraft((current) => withCatalogDefaults(current, nextExecutors));
  };

  useEffect(() => {
    void reload().catch((caught: unknown) => {
      setError(caught instanceof Error ? caught.message : t("recipes.loadError"));
    });
  }, [locale, t]);

  useEffect(() => {
    if (!seed) {
      return;
    }
    setReturnToWork(true);
    setDraft((current) => applySeed(current, seed, current.executor_type));
    setError(null);
    onSeedConsumed?.();
  }, [seed, onSeedConsumed]);

  const catalog = useMemo(
    () => executors.find((item) => item.executor_type === draft.executor_type),
    [executors, draft.executor_type],
  );
  const suggestedName = suggestedRecipeName(draft, sources, catalog, t);
  const executorByType = useMemo(
    () => new Map(executors.map((item) => [item.executor_type, item])),
    [executors],
  );
  const formFirst = Boolean(draft.id || returnToWork || recipes.length === 0);
  const conversationOptions = useMemo(
    () => conversationChoices(conversations, draft),
    [conversations, draft.thread_id, draft.thread_title],
  );

  const resetDraft = () => {
    setReturnToWork(false);
    setError(null);
    setDraft(emptyDraftFrom(executors));
  };

  const editRecipe = (recipe: RecipeView) => {
    setReturnToWork(false);
    setError(null);
    setDraft(draftFromRecipe(recipe, executorByType.get(recipe.executor_type)));
    requestAnimationFrame(() => {
      formRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  };

  const save = async () => {
    if (!draft.executor_type) {
      return;
    }
    const match = draftMatch(draft);
    if (!canAutoStart(match, draft)) {
      setError(scopeError(draft, t));
      return;
    }
    const required = missingRequiredField(catalog, draft.config);
    if (required) {
      setError(t("recipes.errRequired", { field: required }));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await saveRecipe(
        {
          name: (draft.name.trim() || suggestedName).trim(),
          match,
          trigger: draftTrigger(draft),
          executor_type: draft.executor_type,
          executor_config: draft.config,
          can_write_back: writeBackAvailable(draft, conversations)
            ? draft.can_write_back
            : false,
          include_context: draft.include_context,
          enabled: draft.enabled,
        },
        draft.id,
      );
      const goBack = returnToWork && !draft.id;
      resetDraft();
      await reload();
      if (goBack) {
        onBound?.();
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("recipes.saveError"));
    } finally {
      setBusy(false);
    }
  };

  const listCard =
    recipes.length === 0 ? null : (
      <section className="card recipe-saved">
        <div className="card-head">
          <h2>{t("recipes.yours")}</h2>
          {draft.id ? (
            <button type="button" className="ghost" onClick={resetDraft}>
              {t("recipes.new")}
            </button>
          ) : null}
        </div>
        <ul className="recipe-list">
          {recipes.map((recipe) => {
            const invoke = invokeCopy(
              executorByType.get(recipe.executor_type),
              recipe.executor_config,
            );
            const next = nextRunCopy(recipe, t);
            const last = lastRunCopy(recipe, t);
            const conflict = conflictCopy(recipe, recipes, t);
            return (
              <li
                key={recipe.id}
                className={`recipe-card${draft.id === recipe.id ? " is-open" : ""}`}
              >
                <button
                  type="button"
                  className="recipe-card-hit"
                  onClick={() => editRecipe(recipe)}
                >
                  <div className="recipe-card-title">
                    <strong>{recipe.name}</strong>
                    {recipe.enabled ? null : (
                      <span className="recipe-pill">{t("recipes.paused")}</span>
                    )}
                  </div>
                  <p className="recipe-card-line">
                    {recipeCardLine(
                      recipe,
                      sources,
                      conversations,
                      executorByType.get(recipe.executor_type)?.label ??
                        recipe.executor_type,
                      t,
                    )}
                  </p>
                  {next ? <p className="recipe-card-next">{next}</p> : null}
                  {last ? <p className="recipe-card-next">{last}</p> : null}
                  {conflict ? <p className="recipe-card-next">{conflict}</p> : null}
                  {invoke ? <p className="recipe-card-how">{invoke}</p> : null}
                </button>
                <div className="install-actions">
                  <button
                    type="button"
                    className="ghost"
                    disabled={busy}
                    onClick={() => {
                      if (!window.confirm(t("recipes.deleteConfirm", { name: recipe.name }))) {
                        return;
                      }
                      void deleteRecipe(recipe.id)
                        .then(() => {
                          if (draft.id === recipe.id) {
                            resetDraft();
                          }
                          return reload();
                        })
                        .catch((caught: unknown) => {
                          setError(
                            caught instanceof Error
                              ? caught.message
                              : t("recipes.deleteError"),
                          );
                        });
                    }}
                  >
                    {t("recipes.delete")}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </section>
    );

  const formCard = (
    <section className="card recipe-editor" ref={formRef}>
      <header className="recipe-editor-head">
        <h2>{formTitle(draft, returnToWork, t)}</h2>
      </header>
      {executors.length === 0 ? (
        <p className="muted">{t("recipes.noExecutor")}</p>
      ) : (
        <form
          className="recipe-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="recipe-stack">
              <section className="recipe-section">
                <h3>{t("recipes.triggerLegend")}</h3>
                <fieldset className="recipe-scope">
                  <div className="seg">
                    {triggerChoices(t).map((choice) => (
                      <button
                        key={choice.id}
                        type="button"
                        className={draft.trigger_kind === choice.id ? "active" : undefined}
                        onClick={() =>
                          setDraft((current) =>
                            withSuggestedName(applyTriggerKind(current, choice.id)),
                          )
                        }
                      >
                        {choice.label}
                      </button>
                    ))}
                  </div>
                  <p className="muted">{triggerHint(draft.trigger_kind, t)}</p>
                </fieldset>
                {draft.trigger_kind !== "pull" ? (
                <fieldset className="recipe-scope">
                  <legend>{t("recipes.watchLegend")}</legend>
                  <div className="seg">
                    {scopeChoices(t).map((choice) => (
                      <button
                        key={choice.id}
                        type="button"
                        className={draft.scope === choice.id ? "active" : undefined}
                        onClick={() =>
                          setDraft((current) =>
                            withSuggestedName({ ...current, scope: choice.id }),
                          )
                        }
                      >
                        {choice.label}
                      </button>
                    ))}
                  </div>
                </fieldset>
                ) : null}

                {draft.scope === "source" ? (
                  <div className="field">
                    <span>{t("recipes.source")}</span>
                    <MenuSelect
                      value={draft.source}
                      placeholder={t("recipes.chooseSource")}
                      options={sources.map((source) => ({
                        value: source.id,
                        label: source.label,
                      }))}
                      onChange={(source) =>
                        setDraft((current) =>
                          withSuggestedName({
                            ...current,
                            source,
                            unit_kind: unitKindsForSource(sources, source).some(
                              (item) => item.id === current.unit_kind,
                            )
                              ? current.unit_kind
                              : "",
                          }),
                        )
                      }
                    />
                  </div>
                ) : null}

                {draft.trigger_kind !== "pull" && draft.scope !== "thread"
                  ? unitKindField(draft, sources, setDraft, t)
                  : null}

                {draft.scope === "thread" || draft.trigger_kind === "pull" ? (
                  <div className="field">
                    <span>{t("recipes.conversation")}</span>
                    {conversationOptions.length === 0 && !draft.thread_id ? (
                      <p className="field-empty">{t("recipes.noConversation")}</p>
                    ) : (
                      <MenuSelect
                        value={draft.thread_id}
                        placeholder={t("recipes.chooseConversation")}
                        searchable={conversationOptions.length > 6}
                        options={conversationOptions}
                        onChange={(thread_id) => {
                          const picked = conversationOptions.find(
                            (item) => item.id === thread_id,
                          );
                          setDraft((current) =>
                            withSuggestedName({
                              ...current,
                              thread_id,
                              thread_title: picked?.label ?? thread_id,
                              source: picked?.source ?? current.source,
                              can_write_back:
                                picked?.can_send === false
                                  ? false
                                  : current.can_write_back,
                            }),
                          );
                        }}
                      />
                    )}
                  </div>
                ) : null}

                {draft.trigger_kind === "pull" ? (
                  <div className="field">
                    <span>{t("recipes.interval")}</span>
                    <div className="seg">
                      {PULL_INTERVALS.map((choice) => (
                        <button
                          key={choice.ms}
                          type="button"
                          className={draft.interval_ms === choice.ms ? "active" : undefined}
                          onClick={() =>
                            setDraft((current) => ({ ...current, interval_ms: choice.ms }))
                          }
                        >
                          {t(choice.label)}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
              </section>

              <section className="recipe-section">
                <h3>{t("recipes.then")}</h3>
                <div className="field">
                  {executors.length === 1 ? (
                    <p className="recipe-chip">{executors[0].label}</p>
                  ) : (
                    <>
                      <span>{t("recipes.runWith")}</span>
                      <MenuSelect
                        value={draft.executor_type}
                        options={executors.map((item) => ({
                          value: item.executor_type,
                          label: item.label,
                        }))}
                        onChange={(executor_type) =>
                          setDraft((current) =>
                            withSuggestedName({
                              ...current,
                              executor_type,
                              config: configFromCatalog(
                                executors.find((item) => item.executor_type === executor_type),
                              ),
                            }),
                          )
                        }
                      />
                    </>
                  )}
                </div>
                {catalog?.fields.length ? (
                  <RecipeParams
                    catalog={catalog}
                    values={draft.config}
                    fallbackTitle={t("recipes.params")}
                    onChange={(key, value) =>
                      setDraft((current) => ({
                        ...current,
                        config: { ...current.config, [key]: value },
                      }))
                    }
                  />
                ) : null}
              </section>
              <MoreOptions
                key={draft.id ?? "new"}
                draft={draft}
                setDraft={setDraft}
                t={t}
              />
          </div>

          <div className="recipe-form-foot">
            <div className="recipe-switches">
              <SwitchRow
                checked={
                  writeBackAvailable(draft, conversations) && draft.can_write_back
                }
                disabled={!writeBackAvailable(draft, conversations)}
                onChange={(can_write_back) =>
                  setDraft((current) => ({ ...current, can_write_back }))
                }
              >
                {t("recipes.writeBackCheck")}
              </SwitchRow>
              {draft.id ? (
                <SwitchRow
                  checked={draft.enabled}
                  onChange={(enabled) => setDraft((current) => ({ ...current, enabled }))}
                >
                  {t("recipes.enabledCheck")}
                </SwitchRow>
              ) : null}
              {!writeBackAvailable(draft, conversations) ? (
                <p className="muted recipe-writeback-hint">
                  {t("recipes.writeBackUnavailable")}
                </p>
              ) : draft.can_write_back ? (
                <p className="muted recipe-writeback-hint">
                  {t(
                    draft.trigger_kind === "pull"
                      ? "recipes.writeBackHintPull"
                      : "recipes.writeBackHint",
                  )}
                </p>
              ) : null}
            </div>

            <div className="recipe-commit">
              <label className="field">
                <span>{t("recipes.name")}</span>
                <input
                  value={draft.name}
                  placeholder={suggestedName}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      name: event.target.value,
                      nameTouched: true,
                    }))
                  }
                />
              </label>
              <div className="install-actions">
                {draft.id || returnToWork ? (
                  <button type="button" className="ghost" onClick={resetDraft}>
                    {t("recipes.cancel")}
                  </button>
                ) : null}
                <button
                  type="submit"
                  className="primary"
                  disabled={
                    busy ||
                    !draft.executor_type ||
                    ((draft.scope === "thread" || draft.trigger_kind === "pull") &&
                      !draft.thread_id)
                  }
                >
                  {busy
                    ? t("recipes.saving")
                    : draft.id
                      ? t("recipes.update")
                      : returnToWork
                        ? t("recipes.bindBack")
                        : t("recipes.save")}
                </button>
              </div>
            </div>
          </div>
        </form>
      )}
      {error ? <p className="action-error">{error}</p> : null}
    </section>
  );

  return (
    <div className="page page-wide">
      <header className="page-hero">
        <p className="page-eyebrow">{t("recipes.eyebrow")}</p>
        <h1>{t("recipes.title")}</h1>
        <p className="page-lead">{t("recipes.lead")}</p>
      </header>
      {formFirst ? formCard : null}
      {listCard}
      {formFirst ? null : formCard}
    </div>
  );
}

type Translate = (
  key: MessageKey,
  vars?: Record<string, string | number>,
) => string;

function SwitchRow({
  checked,
  onChange,
  children,
  disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  children: string;
  disabled?: boolean;
}) {
  return (
    <div className={`switch-row${disabled ? " is-disabled" : ""}`}>
      <span>{children}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        className={`switch${checked ? " is-on" : ""}`}
        onClick={() => onChange(!checked)}
      />
    </div>
  );
}

function unitKindsForSource(
  sources: RecipeSourceOption[],
  sourceId: string,
): Array<{ id: string; label: string }> {
  return sources.find((item) => item.id === sourceId)?.unit_kinds ?? [];
}

function unitKindOptions(
  draft: RecipeDraft,
  sources: RecipeSourceOption[],
): Array<{ value: string; label: string }> {
  if (draft.scope === "source") {
    return unitKindsForSource(sources, draft.source).map((item) => ({
      value: item.id,
      label: item.label,
    }));
  }
  const options: Array<{ value: string; label: string }> = [];
  const seen = new Set<string>();
  for (const source of sources) {
    for (const kind of source.unit_kinds ?? []) {
      if (seen.has(kind.id)) {
        continue;
      }
      seen.add(kind.id);
      options.push({
        value: kind.id,
        label: source.label ? `${source.label} · ${kind.label}` : kind.label,
      });
    }
  }
  return options;
}

function unitKindField(
  draft: RecipeDraft,
  sources: RecipeSourceOption[],
  setDraft: Dispatch<SetStateAction<RecipeDraft>>,
  t: Translate,
) {
  const options = unitKindOptions(draft, sources);
  if (options.length === 0 && !draft.unit_kind) {
    return null;
  }
  if (draft.unit_kind && !options.some((item) => item.value === draft.unit_kind)) {
    options.unshift({ value: draft.unit_kind, label: draft.unit_kind });
  }
  return (
    <div className="field">
      <span>{t("recipes.unitKind")}</span>
      <MenuSelect
        value={draft.unit_kind}
        placeholder={t("recipes.unitKindAny")}
        options={[{ value: "", label: t("recipes.unitKindAny") }, ...options]}
        onChange={(unit_kind) =>
          setDraft((current) => withSuggestedName({ ...current, unit_kind }))
        }
      />
      <p className="muted">{t("recipes.unitKindHint")}</p>
    </div>
  );
}

function scopeChoices(t: Translate): Array<{ id: RecipeScope; label: string }> {
  return [
    { id: "tasks", label: t("recipes.scopeTasks") },
    { id: "source", label: t("recipes.scopeSource") },
    { id: "thread", label: t("recipes.scopeThread") },
  ];
}

function triggerChoices(
  t: Translate,
): Array<{ id: RecipeTriggerKind; label: string }> {
  return [
    { id: "push", label: t("recipes.triggerPush") },
    { id: "pull", label: t("recipes.triggerPull") },
    { id: "manual", label: t("recipes.triggerManual") },
  ];
}

function MoreOptions({
  draft,
  setDraft,
  t,
}: {
  draft: RecipeDraft;
  setDraft: Dispatch<SetStateAction<RecipeDraft>>;
  t: Translate;
}) {
  const advancedDirty =
    Boolean(draft.thread_facet) ||
    (draft.trigger_kind === "push" && !draft.coalesce) ||
    (draft.trigger_kind !== "pull" && draft.include_context);
  const [open, setOpen] = useState(advancedDirty);
  return (
    <div className="recipe-more">
      <button
        type="button"
        className="recipe-more-toggle"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {t("recipes.advanced")}
        <span aria-hidden="true">{open ? "−" : "+"}</span>
      </button>
      {open ? (
      <div className="recipe-more-body">
        <div className="field">
          <span>{t("recipes.facet")}</span>
          <MenuSelect
            value={draft.thread_facet}
            options={[
              { value: "", label: t("recipes.facetNone") },
              { value: "ticket", label: t("recipes.facetTicket") },
              { value: "agent", label: t("recipes.facetAgent") },
              { value: "chat", label: t("recipes.facetChat") },
            ]}
            onChange={(thread_facet) =>
              setDraft((current) => ({
                ...current,
                thread_facet: thread_facet as ThreadFacet | "",
              }))
            }
          />
        </div>
        {draft.trigger_kind === "pull" ? (
          <p className="muted">{t("recipes.includeContextHintPull")}</p>
        ) : (
          <>
            <SwitchRow
              checked={draft.include_context}
              onChange={(include_context) =>
                setDraft((current) => ({ ...current, include_context }))
              }
            >
              {t("recipes.includeContextCheck")}
            </SwitchRow>
            <p className="muted">{t("recipes.includeContextHint")}</p>
          </>
        )}
        {draft.trigger_kind === "push" ? (
          <>
            <SwitchRow
              checked={draft.coalesce}
              onChange={(coalesce) =>
                setDraft((current) => ({ ...current, coalesce }))
              }
            >
              {t("recipes.coalesceCheck")}
            </SwitchRow>
            <p className="muted">{t("recipes.coalesceHint")}</p>
          </>
        ) : null}
        {draft.can_write_back ? (
          <p className="muted">{t("recipes.writeBackMatchHint")}</p>
        ) : null}
      </div>
      ) : null}
    </div>
  );
}

function triggerHint(kind: RecipeTriggerKind, t: Translate): string {
  if (kind === "pull") {
    return t("recipes.triggerPullHint");
  }
  if (kind === "manual") {
    return t("recipes.triggerManualHint");
  }
  return t("recipes.triggerPushHint");
}

function applyTriggerKind(draft: RecipeDraft, kind: RecipeTriggerKind): RecipeDraft {
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

interface RecipeDraft {
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
  enabled: boolean;
}

function emptyDraft(executorType = ""): RecipeDraft {
  return {
    name: "",
    nameTouched: false,
    trigger_kind: "push",
    interval_ms: 60 * 60 * 1000,
    coalesce: true,
    scope: "tasks",
    source: "",
    thread_id: "",
    thread_title: "",
    thread_facet: "",
    unit_kind: "",
    executor_type: executorType,
    config: {},
    can_write_back: false,
    include_context: false,
    enabled: true,
  };
}

function emptyDraftFrom(executors: ExecutorCatalogEntry[]): RecipeDraft {
  const first = executors[0];
  return {
    ...emptyDraft(first?.executor_type ?? ""),
    config: configFromCatalog(first),
  };
}

function withCatalogDefaults(
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

function applySeed(
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

function draftFromRecipe(
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
    enabled: recipe.enabled,
  };
}

function draftMatch(draft: RecipeDraft): RecipeMatch {
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

function draftTrigger(draft: RecipeDraft): RecipeView["trigger"] {
  if (draft.trigger_kind === "pull") {
    return { kind: "pull", interval_ms: draft.interval_ms };
  }
  if (draft.trigger_kind === "manual") {
    return { kind: "manual" };
  }
  return { kind: "push", coalesce: draft.coalesce };
}

function canAutoStart(match: RecipeMatch, draft: RecipeDraft): boolean {
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

function scopeError(draft: RecipeDraft, t: Translate): string {
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

function withSuggestedName(draft: RecipeDraft): RecipeDraft {
  if (draft.nameTouched) {
    return draft;
  }
  return { ...draft, name: "" };
}

function suggestedRecipeName(
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

function formTitle(
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

function conversationChoices(
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

function recipeCardLine(
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
  return t("recipes.cardLine", {
    when: whenCopy(recipe, sources, conversations, t),
    executor,
    outcome,
  });
}

function writeBackAvailable(
  draft: Pick<RecipeDraft, "thread_id">,
  conversations: RecipeConversationOption[],
): boolean {
  const picked = conversations.find((item) => item.id === draft.thread_id);
  return picked?.can_send !== false;
}

function lastRunCopy(recipe: RecipeView, t: Translate): string | null {
  const run = recipe.last_run;
  if (!run) {
    return null;
  }
  if (run.status === "failed") {
    return t("recipes.lastRunFailed");
  }
  if (run.status === "completed") {
    return t("recipes.lastRunDone");
  }
  if (run.status === "cancelled") {
    return t("recipes.lastRunSkipped");
  }
  if (run.status === "running" || run.status === "waiting_human") {
    return t("recipes.lastRunRunning");
  }
  return null;
}

function conflictCopy(
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

function nextRunCopy(recipe: RecipeView, t: Translate): string | null {
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
