import { useEffect, useMemo, useState } from "react";
import {
  deleteRecipe,
  fetchExecutors,
  fetchRecipes,
  saveRecipe,
} from "./api";
import { useLocale } from "./LocaleContext";
import type { MessageKey } from "../../shared/i18n.ts";
import type {
  ExecutorCatalogEntry,
  RecipeMatch,
  RecipeSeed,
  RecipeSourceOption,
  RecipeView,
  ThreadFacet,
} from "./types";

type RecipeScope = "tasks" | "source" | "thread";

export function RecipesPage({
  sources,
  seed,
  onSeedConsumed,
  onBound,
}: {
  sources: RecipeSourceOption[];
  seed?: RecipeSeed | null;
  onSeedConsumed?: () => void;
  onBound?: () => void;
}) {
  const { t } = useLocale();
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
    setDraft((current) =>
      current.executor_type
        ? current
        : { ...current, executor_type: nextExecutors[0]?.executor_type ?? "" },
    );
  };

  useEffect(() => {
    void reload().catch((caught: unknown) => {
      setError(caught instanceof Error ? caught.message : t("recipes.loadError"));
    });
  }, []);

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

  const save = async () => {
    if (!draft.executor_type) {
      return;
    }
    const match = draftMatch(draft);
    if (!canAutoStart(match)) {
      setError(scopeError(draft, t));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await saveRecipe(
        {
          name: (draft.name.trim() || suggestedName).trim(),
          match,
          executor_type: draft.executor_type,
          executor_config: draft.config,
          can_write_back: draft.can_write_back,
          enabled: draft.enabled,
        },
        draft.id,
      );
      const goBack = returnToWork && !draft.id;
      setReturnToWork(false);
      setDraft(emptyDraft(executors[0]?.executor_type ?? ""));
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

  return (
    <div className="page page-wide">
      <header className="page-hero">
        <p className="page-eyebrow">{t("recipes.eyebrow")}</p>
        <h1>{t("recipes.title")}</h1>
        <p className="page-lead">{t("recipes.lead")}</p>
      </header>

      <ol className="step-grid">
        <li>
          <span className="step-index">1</span>
          <strong>{t("recipes.step1Title")}</strong>
          <span>{t("recipes.step1Body")}</span>
        </li>
        <li>
          <span className="step-index">2</span>
          <strong>{t("recipes.step2Title")}</strong>
          <span>{t("recipes.step2Body")}</span>
        </li>
        <li>
          <span className="step-index">3</span>
          <strong>{t("recipes.step3Title")}</strong>
          <span>{t("recipes.step3Body")}</span>
        </li>
      </ol>

      <section className="card">
        <div className="card-head">
          <h2>{t("recipes.yours")}</h2>
          {draft.id ? (
            <button
              type="button"
              className="ghost"
              onClick={() => {
                setReturnToWork(false);
                setDraft(emptyDraft(executors[0]?.executor_type ?? ""));
              }}
            >
              {t("recipes.new")}
            </button>
          ) : null}
        </div>
        {recipes.length === 0 ? (
          <p className="muted">{t("recipes.empty")}</p>
        ) : (
          <ul className="recipe-list">
            {recipes.map((recipe) => (
              <li key={recipe.id} className="recipe-card">
                <div className="recipe-card-main">
                  <div className="recipe-card-title">
                    <strong>{recipe.name}</strong>
                    <span className={`recipe-pill${recipe.enabled ? " is-on" : ""}`}>
                      {recipe.enabled ? t("recipes.on") : t("recipes.off")}
                    </span>
                  </div>
                  <dl className="recipe-meta">
                    <div>
                      <dt>{t("recipes.when")}</dt>
                      <dd>{whenCopy(recipe, sources, t)}</dd>
                    </div>
                    <div>
                      <dt>{t("recipes.then")}</dt>
                      <dd>
                        {t("recipes.thenRun", {
                          executor:
                            executorByType.get(recipe.executor_type)?.label ??
                            recipe.executor_type,
                        })}
                      </dd>
                    </div>
                    <div>
                      <dt>{t("recipes.afterDone")}</dt>
                      <dd>
                        {recipe.can_write_back
                          ? t("recipes.writeBackYes")
                          : t("recipes.writeBackNo")}
                      </dd>
                    </div>
                  </dl>
                </div>
                <div className="install-actions">
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => {
                      setReturnToWork(false);
                      setDraft(draftFromRecipe(recipe));
                    }}
                  >
                    {t("recipes.edit")}
                  </button>
                  <button
                    type="button"
                    className="ghost"
                    disabled={busy}
                    onClick={() => {
                      if (!window.confirm(t("recipes.deleteConfirm", { name: recipe.name }))) {
                        return;
                      }
                      void deleteRecipe(recipe.id)
                        .then(reload)
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
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>{formTitle(draft, returnToWork, t)}</h2>
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
            <fieldset className="recipe-scope">
              <legend>{t("recipes.watchLegend")}</legend>
              {scopeChoices(t).map((choice) => (
                <button
                  key={choice.id}
                  type="button"
                  className={`choice${draft.scope === choice.id ? " active" : ""}`}
                  onClick={() =>
                    setDraft((current) =>
                      withSuggestedName({ ...current, scope: choice.id }),
                    )
                  }
                >
                  <span className="choice-mark" />
                  <span>
                    <strong>{choice.label}</strong>
                    <span className="muted">{choice.hint}</span>
                  </span>
                </button>
              ))}
            </fieldset>

            {draft.scope === "source" ? (
              <label className="field">
                <span>{t("recipes.source")}</span>
                <select
                  value={draft.source}
                  required
                  onChange={(event) =>
                    setDraft((current) =>
                      withSuggestedName({ ...current, source: event.target.value }),
                    )
                  }
                >
                  <option value="">{t("recipes.chooseSource")}</option>
                  {sources.map((source) => (
                    <option key={source.id} value={source.id}>
                      {source.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}

            {draft.scope === "thread" ? (
              <label className="field">
                <span>{t("recipes.conversation")}</span>
                {draft.thread_id ? (
                  <input
                    value={draft.thread_title || draft.thread_id}
                    readOnly
                    title={draft.thread_id}
                  />
                ) : (
                  <p className="field-empty">{t("recipes.bindHint")}</p>
                )}
              </label>
            ) : null}

            <label className="field">
              <span>{t("recipes.runWith")}</span>
              <select
                value={draft.executor_type}
                required
                onChange={(event) =>
                  setDraft((current) =>
                    withSuggestedName({
                      ...current,
                      executor_type: event.target.value,
                      config: {},
                    }),
                  )
                }
              >
                {executors.map((item) => (
                  <option key={item.executor_type} value={item.executor_type}>
                    {item.label}
                  </option>
                ))}
              </select>
              {catalog?.description ? (
                <span className="muted">{catalog.description}</span>
              ) : catalog?.attach === "absentee" ? (
                <span className="muted">{t("recipes.absentee")}</span>
              ) : null}
            </label>

            {(catalog?.fields ?? []).map((field) => (
              <label key={field.key} className="field">
                <span>
                  {field.label}
                  {field.required ? " *" : ""}
                </span>
                <input
                  value={draft.config[field.key] ?? ""}
                  placeholder={field.placeholder}
                  required={field.required}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      config: { ...current.config, [field.key]: event.target.value },
                    }))
                  }
                />
              </label>
            ))}

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

            <label className="check-item">
              <input
                type="checkbox"
                checked={draft.can_write_back}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    can_write_back: event.target.checked,
                  }))
                }
              />
              <span>{t("recipes.writeBackCheck")}</span>
            </label>
            <label className="check-item">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    enabled: event.target.checked,
                  }))
                }
              />
              <span>{t("recipes.enabledCheck")}</span>
            </label>

            <details className="recipe-advanced" open={Boolean(draft.thread_facet)}>
              <summary>{t("recipes.advanced")}</summary>
              <label className="field">
                <span>{t("recipes.facet")}</span>
                <select
                  value={draft.thread_facet}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      thread_facet: event.target.value as ThreadFacet | "",
                    }))
                  }
                >
                  <option value="">{t("recipes.facetNone")}</option>
                  <option value="ticket">{t("recipes.facetTicket")}</option>
                  <option value="agent">{t("recipes.facetAgent")}</option>
                  <option value="chat">{t("recipes.facetChat")}</option>
                </select>
              </label>
            </details>

            <div className="install-actions">
              {draft.id || returnToWork ? (
                <button
                  type="button"
                  className="ghost"
                  onClick={() => {
                    setReturnToWork(false);
                    setDraft(emptyDraft(executors[0]?.executor_type ?? ""));
                  }}
                >
                  {t("recipes.cancel")}
                </button>
              ) : null}
              <button
                type="submit"
                className="primary"
                disabled={busy || !draft.executor_type || (draft.scope === "thread" && !draft.thread_id)}
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
          </form>
        )}
        {error ? <p className="action-error">{error}</p> : null}
      </section>
    </div>
  );
}

type Translate = (
  key: MessageKey,
  vars?: Record<string, string | number>,
) => string;

function scopeChoices(t: Translate): Array<{ id: RecipeScope; label: string; hint: string }> {
  return [
    {
      id: "tasks",
      label: t("recipes.scopeTasks"),
      hint: t("recipes.scopeTasksHint"),
    },
    {
      id: "source",
      label: t("recipes.scopeSource"),
      hint: t("recipes.scopeSourceHint"),
    },
    {
      id: "thread",
      label: t("recipes.scopeThread"),
      hint: t("recipes.scopeThreadHint"),
    },
  ];
}

interface RecipeDraft {
  id?: string;
  name: string;
  nameTouched: boolean;
  scope: RecipeScope;
  source: string;
  thread_id: string;
  thread_title: string;
  thread_facet: ThreadFacet | "";
  executor_type: string;
  config: Record<string, string>;
  can_write_back: boolean;
  enabled: boolean;
}

function emptyDraft(executorType = ""): RecipeDraft {
  return {
    name: "",
    nameTouched: false,
    scope: "tasks",
    source: "",
    thread_id: "",
    thread_title: "",
    thread_facet: "",
    executor_type: executorType,
    config: {},
    can_write_back: false,
    enabled: true,
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
  });
}

function draftFromRecipe(recipe: RecipeView): RecipeDraft {
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
    scope: recipe.match.thread_id
      ? "thread"
      : recipe.match.source
        ? "source"
        : "tasks",
    source: recipe.match.source ?? "",
    thread_id: recipe.match.thread_id ?? "",
    thread_title: recipe.match.thread_id ?? "",
    thread_facet: recipe.match.thread_facet ?? "",
    executor_type: recipe.executor_type,
    config,
    can_write_back: recipe.can_write_back,
    enabled: recipe.enabled,
  };
}

function draftMatch(draft: RecipeDraft): RecipeMatch {
  return {
    ...(draft.scope === "thread"
      ? { thread_id: draft.thread_id.trim() }
      : { record_class: "task" }),
    ...(draft.scope === "source" && draft.source.trim()
      ? { source: draft.source.trim() }
      : {}),
    ...(draft.thread_facet ? { thread_facet: draft.thread_facet } : {}),
  };
}

function canAutoStart(match: RecipeMatch): boolean {
  return Boolean(
    match.thread_id ||
      match.record_class === "task" ||
      (match.source && match.record_class && match.record_class !== "utterance"),
  );
}

function scopeError(draft: RecipeDraft, t: Translate): string {
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
  if (draft.scope === "thread") {
    const title = draft.thread_title.trim() || t("recipes.thisConversation");
    return t("recipes.suggestedThread", { title, executor });
  }
  if (draft.scope === "source") {
    const source =
      sources.find((item) => item.id === draft.source)?.label ??
      t("recipes.sourceFallback");
    return t("recipes.suggestedSource", { source, executor });
  }
  return t("recipes.suggestedTasks", { executor });
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

function whenCopy(
  recipe: RecipeView,
  sources: RecipeSourceOption[],
  t: Translate,
): string {
  if (recipe.match.thread_id) {
    return t("recipes.whenOnly", { thread: shortThread(recipe.match.thread_id) });
  }
  const sourceLabel = recipe.match.source
    ? (sources.find((item) => item.id === recipe.match.source)?.label ??
      recipe.match.source)
    : null;
  const facet =
    recipe.match.thread_facet === "ticket"
      ? t("recipes.facetTickets")
      : recipe.match.thread_facet === "agent"
        ? t("recipes.facetAgents")
        : recipe.match.thread_facet === "chat"
          ? t("recipes.facetChats")
          : null;
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
