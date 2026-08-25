import { useEffect, useMemo, useRef, useState } from "react";
import {
  deleteRecipe,
  fetchExecutors,
  fetchRecipes,
  saveRecipe,
} from "./api";
import { useLocale } from "./LocaleContext";
import { MenuSelect } from "./MenuSelect";
import { RecipeParams } from "./RecipeParams";
import { configFromCatalog, invokeCopy } from "./recipe-params";
import type { MessageKey } from "../../shared/i18n.ts";
import type {
  ExecutorCatalogEntry,
  RecipeConversationOption,
  RecipeMatch,
  RecipeSeed,
  RecipeSourceOption,
  RecipeView,
  ThreadFacet,
} from "./types";

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
  const { t } = useLocale();
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
      <section className="card">
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
                    <span className={`recipe-pill${recipe.enabled ? " is-on" : ""}`}>
                      {recipe.enabled ? t("recipes.on") : t("recipes.off")}
                    </span>
                    {recipe.can_write_back ? (
                      <span className="recipe-pill">{t("recipes.writeBackYes")}</span>
                    ) : null}
                  </div>
                  <p className="recipe-card-line">
                    {whenCopy(recipe, sources, conversations, t)}
                    <span aria-hidden="true"> → </span>
                    {executorByType.get(recipe.executor_type)?.label ?? recipe.executor_type}
                  </p>
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
    <section className="card" ref={formRef}>
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
                  setDraft((current) => withSuggestedName({ ...current, source }))
                }
              />
            </div>
          ) : null}

          {draft.scope === "thread" ? (
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
                    const picked = conversationOptions.find((item) => item.id === thread_id);
                    setDraft((current) =>
                      withSuggestedName({
                        ...current,
                        thread_id,
                        thread_title: picked?.label ?? thread_id,
                        source: picked?.source ?? current.source,
                      }),
                    );
                  }}
                />
              )}
            </div>
          ) : null}

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

          <div className="field">
            <span>{t("recipes.runWith")}</span>
            {executors.length === 1 ? (
              <p className="recipe-chip">{executors[0].label}</p>
            ) : (
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
            )}
          </div>

          {catalog ? (
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

          <div className="recipe-switches">
            <SwitchRow
              checked={draft.can_write_back}
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
          </div>

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
                busy || !draft.executor_type || (draft.scope === "thread" && !draft.thread_id)
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
        </form>
      )}
      {error ? <p className="action-error">{error}</p> : null}
    </section>
  );

  return (
    <div className="page page-wide">
      <header className="page-hero">
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
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  children: string;
}) {
  return (
    <div className="switch-row">
      <span>{children}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        className={`switch${checked ? " is-on" : ""}`}
        onClick={() => onChange(!checked)}
      />
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
    config: configFromCatalog(catalog, config),
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

function whenCopy(
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
