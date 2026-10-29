import {
  deleteRecipe,
  fetchExecutors,
  fetchRecipes,
  saveRecipe,
  tryRecipe,
} from "./api";
import { useLocale } from "./LocaleContext";
import { MenuSelect } from "./MenuSelect";
import {
  MatchPreview,
  MoreOptions,
  PriorityPanel,
  SwitchRow,
  unitKindField,
} from "./RecipeEditor";
import { RecipeParams } from "./RecipeParams";
import { RecipeRow } from "./RecipeRow";
import { RecipeRunHistory } from "./RecipeRunHistory";
import { ScheduleField } from "./ScheduleField";
import {
  applySeed,
  applyTriggerKind,
  canAutoStart,
  conflictCopy,
  conversationChoices,
  draftFromRecipe,
  draftMatch,
  draftTrigger,
  emptyDraft,
  emptyDraftFrom,
  formTitle,
  importErrorKey,
  lastRunCopy,
  nextRunCopy,
  parseMaxConcurrent,
  recipeCardLine,
  saveCoverageCopy,
  scopeChoices,
  scopeError,
  starterDraft,
  suggestedRecipeName,
  triggerChoices,
  triggerHint,
  unitKindsForSource,
  withCatalogDefaults,
  withSuggestedName,
  writeBackAvailable,
  type RecipeDraft,
  type StarterKind,
} from "./recipe-draft";
import { configFromCatalog, invokeCopy, missingRequiredField } from "./recipe-params";
import {
  overlappingPriorityGroup,
  previewRecipeMatch,
  shouldConfirmRecipeSave,
  tryOnceThreadId,
} from "./recipe-preview";
import {
  buildRecipeBundle,
  downloadRecipeBundle,
  parseRecipeBundle,
  type RecipeTransferItem,
} from "./recipe-transfer";
import type {
  ExecutorCatalogEntry,
  RecipeConversationOption,
  RecipeSeed,
  RecipeSourceOption,
  RecipeView,
} from "./types";
import { useEffect, useMemo, useRef, useState } from "react";

export function RecipesPage({
  sources,
  conversations = [],
  seed,
  onSeedConsumed,
  onBound,
  onGoEngine,
  onOpenThread,
}: {
  sources: RecipeSourceOption[];
  conversations?: RecipeConversationOption[];
  seed?: RecipeSeed | null;
  onSeedConsumed?: () => void;
  onBound?: () => void;
  onGoEngine?: () => void;
  onOpenThread?: (threadId: string) => void;
}) {
  const { t, locale } = useLocale();
  const formRef = useRef<HTMLElement>(null);
  const [recipes, setRecipes] = useState<RecipeView[]>([]);
  const [executors, setExecutors] = useState<ExecutorCatalogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [returnToWork, setReturnToWork] = useState(() => Boolean(seed));
  const importRef = useRef<HTMLInputElement>(null);
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
  const matchPreview = useMemo(
    () =>
      previewRecipeMatch({
        match: draftMatch(draft),
        draftId: draft.id,
        conversations,
        recipes,
      }),
    [conversations, draft, recipes],
  );
  const priorityGroup = useMemo(() => {
    const match = draftMatch(draft);
    if (!match || Object.keys(match).length === 0) {
      return [];
    }
    const name = (draft.name.trim() || suggestedName).trim() || t("recipes.formNew");
    return overlappingPriorityGroup(
      {
        id: draft.id ?? "~draft",
        name,
        match,
        enabled: draft.enabled,
      },
      recipes,
    );
  }, [draft, recipes, suggestedName, t]);
  const tryThreadId = useMemo(
    () =>
      tryOnceThreadId({
        matchThreadId: draftMatch(draft).thread_id,
        preview: matchPreview,
      }),
    [draft, matchPreview],
  );

  const runTryOnce = async (writeBack: boolean) => {
    if (!draft.id || !tryThreadId) {
      return;
    }
    if (
      !window.confirm(
        t(writeBack ? "recipes.tryConfirmSend" : "recipes.tryConfirmKeep"),
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await tryRecipe(draft.id, {
        thread_id: tryThreadId,
        write_back: writeBack,
      });
      await reload();
      setNotice(
        t(writeBack ? "recipes.tryStartedSend" : "recipes.tryStartedKeep"),
      );
      onOpenThread?.(result.thread_id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("recipes.tryError"));
    } finally {
      setBusy(false);
    }
  };

  const exportRules = () => {
    if (recipes.length === 0) {
      return;
    }
    downloadRecipeBundle(buildRecipeBundle(recipes));
    setError(null);
    setNotice(t("recipes.exportDone", { count: recipes.length }));
  };

  const importRules = async (file: File) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const raw = await file.text();
      let bundle;
      try {
        bundle = parseRecipeBundle(raw);
      } catch (caught) {
        const code = caught instanceof Error ? caught.message : "invalid_bundle";
        setError(t(importErrorKey(code)));
        return;
      }
      const available = new Set(executors.map((item) => item.executor_type));
      const accepted: RecipeTransferItem[] = [];
      let skipped = 0;
      for (const item of bundle.recipes) {
        if (!available.has(item.executor_type)) {
          skipped += 1;
          continue;
        }
        accepted.push(item);
      }
      if (accepted.length === 0) {
        setError(t("recipes.importNoExecutor"));
        return;
      }
      if (
        !window.confirm(
          t("recipes.importConfirm", {
            count: accepted.length,
            skipped: skipped > 0 ? t("recipes.importSkipped", { count: skipped }) : "",
          }),
        )
      ) {
        return;
      }
      for (const item of accepted) {
        await saveRecipe({
          name: item.name,
          match: item.match,
          trigger: item.trigger,
          executor_type: item.executor_type,
          executor_config: item.executor_config,
          can_write_back: item.can_write_back,
          include_context: item.include_context,
          max_concurrent: item.max_concurrent ?? null,
          enabled: item.enabled,
        });
      }
      await reload();
      setNotice(
        t("recipes.importDone", {
          count: accepted.length,
          skipped: skipped > 0 ? t("recipes.importSkipped", { count: skipped }) : "",
        }),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("recipes.importError"));
    } finally {
      setBusy(false);
      if (importRef.current) {
        importRef.current.value = "";
      }
    }
  };

  const resetDraft = () => {
    setReturnToWork(false);
    setError(null);
    setNotice(null);
    setDraft(emptyDraftFrom(executors, sources));
  };

  const editRecipe = (recipe: RecipeView) => {
    setReturnToWork(false);
    setError(null);
    setDraft(draftFromRecipe(recipe, executorByType.get(recipe.executor_type)));
    requestAnimationFrame(() => {
      formRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  };

  const toggleRecipe = async (recipe: RecipeView) => {
    setBusy(true);
    setError(null);
    try {
      await saveRecipe(
        {
          name: recipe.name,
          match: recipe.match,
          trigger: recipe.trigger,
          executor_type: recipe.executor_type,
          executor_config: recipe.executor_config,
          can_write_back: recipe.can_write_back,
          include_context: recipe.include_context,
          max_concurrent: recipe.max_concurrent ?? null,
          enabled: !recipe.enabled,
        },
        recipe.id,
      );
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("recipes.saveError"));
    } finally {
      setBusy(false);
    }
  };

  const applyStarter = (kind: StarterKind) => {
    setReturnToWork(false);
    setError(null);
    setDraft(
      withSuggestedName(
        starterDraft(kind, emptyDraftFrom(executors, sources), sources, conversations),
      ),
    );
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
    const writeBack =
      writeBackAvailable(draft, conversations) && draft.can_write_back;
    if (
      shouldConfirmRecipeSave({
        isNew: !draft.id,
        triggerKind: draft.trigger_kind,
        scope: draft.scope,
        canWriteBack: writeBack,
        preview: matchPreview,
      })
    ) {
      if (
        !window.confirm(
          t("recipes.saveConfirm", {
            coverage: saveCoverageCopy(matchPreview, draft, t),
            after: writeBack
              ? t("recipes.writeBackYes")
              : t("recipes.writeBackNo"),
          }),
        )
      ) {
        return;
      }
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await saveRecipe(
        {
          name: (draft.name.trim() || suggestedName).trim(),
          match,
          trigger: draftTrigger(draft),
          executor_type: draft.executor_type,
          executor_config: draft.config,
          can_write_back: writeBack,
          include_context: draft.include_context,
          max_concurrent:
            draft.trigger_kind === "pull"
              ? null
              : parseMaxConcurrent(draft.max_concurrent),
          enabled: draft.enabled,
        },
        draft.id,
      );
      const goBack = returnToWork && !draft.id;
      const wasEdit = Boolean(draft.id);
      resetDraft();
      await reload();
      setNotice(t(wasEdit ? "recipes.saveUpdated" : "recipes.saveCreated"));
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
          <div className="recipe-head-actions">
            <button
              type="button"
              className="ghost"
              disabled={busy}
              onClick={exportRules}
            >
              {t("recipes.export")}
            </button>
            <button
              type="button"
              className="ghost"
              disabled={busy || executors.length === 0}
              onClick={() => importRef.current?.click()}
            >
              {t("recipes.import")}
            </button>
            {draft.id ? (
              <button type="button" className="ghost" onClick={resetDraft}>
                {t("recipes.new")}
              </button>
            ) : null}
          </div>
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
            const recentRuns = recipe.recent_runs?.length
              ? recipe.recent_runs
              : recipe.last_run
                ? [recipe.last_run]
                : [];
            const runThread =
              recipe.last_run?.thread_id?.trim() ||
              recipe.match.thread_id?.trim() ||
              "";
            const isOpen = draft.id === recipe.id;
            const priority = overlappingPriorityGroup(recipe, recipes);
            const selfRank = priority.find((row) => row.is_self);
            return (
              <li
                key={recipe.id}
                className={`recipe-card${isOpen ? " is-open" : ""}`}
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
                    {selfRank && selfRank.rank > 0 ? (
                      <span className="recipe-pill">
                        {t("recipes.priorityRank", {
                          rank: selfRank.rank,
                          total: priority.filter((row) => row.enabled).length,
                        })}
                      </span>
                    ) : null}
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
                  {last && recentRuns.length <= 1 ? (
                    <p className="recipe-card-next">{last}</p>
                  ) : null}
                  {conflict ? <p className="recipe-card-next">{conflict}</p> : null}
                  {invoke ? <p className="recipe-card-how">{invoke}</p> : null}
                </button>
                {recentRuns.length > 0 ? (
                  <RecipeRunHistory
                    runs={recentRuns}
                    onOpenThread={onOpenThread}
                    t={t}
                  />
                ) : null}
                <div className="install-actions">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={recipe.enabled}
                    className={`switch${recipe.enabled ? " is-on" : ""}`}
                    disabled={busy}
                    title={recipe.enabled ? t("recipes.off") : t("recipes.on")}
                    onClick={() => {
                      void toggleRecipe(recipe);
                    }}
                  />
                  {runThread && onOpenThread && recipe.last_run ? (
                    <button
                      type="button"
                      className="ghost"
                      disabled={busy}
                      onClick={() => onOpenThread(runThread)}
                    >
                      {t("recipes.openLastRun")}
                    </button>
                  ) : null}
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
      {draft.id
        ? (() => {
            const editing = recipes.find((item) => item.id === draft.id);
            const runs = editing?.recent_runs?.length
              ? editing.recent_runs
              : editing?.last_run
                ? [editing.last_run]
                : [];
            return runs.length > 0 ? (
              <RecipeRunHistory
                runs={runs}
                onOpenThread={onOpenThread}
                t={t}
                dense
              />
            ) : null;
          })()
        : null}
      {executors.length === 0 ? (
        <div className="recipe-gate">
          <p className="muted">{t("recipes.noExecutor")}</p>
          {onGoEngine ? (
            <button type="button" className="primary" onClick={onGoEngine}>
              {t("recipes.goEngine")}
            </button>
          ) : null}
        </div>
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
                <header className="recipe-section-head">
                  <h3>{t("recipes.triggerLegend")}</h3>
                </header>
                <div className="recipe-rows">
                <RecipeRow label={t("recipes.triggerRow")}>
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
                  <p className="recipe-hint">{triggerHint(draft.trigger_kind, t)}</p>
                </RecipeRow>
                {draft.trigger_kind !== "pull" ? (
                <RecipeRow label={t("recipes.watchLegend")}>
                  <div className="seg">
                    {scopeChoices(t).map((choice) => (
                      <button
                        key={choice.id}
                        type="button"
                        className={draft.scope === choice.id ? "active" : undefined}
                        onClick={() => {
                          if (
                            choice.id === "tasks" &&
                            draft.scope !== "tasks" &&
                            !window.confirm(t("recipes.scopeTasksConfirm"))
                          ) {
                            return;
                          }
                          setDraft((current) =>
                            withSuggestedName({ ...current, scope: choice.id }),
                          );
                        }}
                      >
                        {choice.label}
                      </button>
                    ))}
                  </div>
                  {draft.scope === "tasks" ? (
                    <p className="recipe-hint recipe-scope-warn">{t("recipes.scopeTasksWarn")}</p>
                  ) : null}
                </RecipeRow>
                ) : null}

                {draft.scope === "source" ? (
                  <RecipeRow label={t("recipes.source")}>
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
                  </RecipeRow>
                ) : null}

                {draft.trigger_kind !== "pull" && draft.scope !== "thread"
                  ? unitKindField(draft, sources, setDraft, t)
                  : null}

                {draft.scope === "thread" || draft.trigger_kind === "pull" ? (
                  <RecipeRow label={t("recipes.conversation")}>
                    {conversationOptions.length === 0 && !draft.thread_id ? (
                      <div className="recipe-gate">
                        <p className="field-empty">{t("recipes.noConversation")}</p>
                        <p className="recipe-hint">{t("recipes.noConversationHint")}</p>
                        {onBound ? (
                          <button type="button" className="ghost" onClick={onBound}>
                            {t("recipes.goInbox")}
                          </button>
                        ) : null}
                      </div>
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
                  </RecipeRow>
                ) : null}

                {draft.trigger_kind === "pull" ? (
                  <RecipeRow label={t("recipes.interval")}>
                    <ScheduleField
                      draft={draft}
                      t={t}
                      onChange={(patch) =>
                        setDraft((current) => ({ ...current, ...patch }))
                      }
                    />
                  </RecipeRow>
                ) : null}

                <RecipeRow label={t("recipes.previewTitle")}>
                  <MatchPreview
                    preview={matchPreview}
                    draft={draft}
                    t={t}
                  />
                  {priorityGroup.length > 0 ? (
                    <PriorityPanel rows={priorityGroup} t={t} />
                  ) : null}
                </RecipeRow>
                </div>
              </section>

              <section className="recipe-section">
                <header className="recipe-section-head">
                  <h3>{t("recipes.then")}</h3>
                </header>
                <div className="recipe-rows">
                <RecipeRow label={t("recipes.runWith")}>
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
                  {catalog?.description ? (
                    <p className="recipe-hint">{catalog.description}</p>
                  ) : null}
                </RecipeRow>
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
                <MoreOptions
                  key={draft.id ?? "new"}
                  draft={draft}
                  setDraft={setDraft}
                  t={t}
                />
                </div>
              </section>

              <section className="recipe-section">
                <header className="recipe-section-head">
                  <h3>{t("recipes.afterDone")}</h3>
                </header>
                <div className="recipe-rows">
                <RecipeRow label={t("recipes.result")}>
                  <div className="seg">
                    <button
                      type="button"
                      className={
                        writeBackAvailable(draft, conversations) && draft.can_write_back
                          ? "active"
                          : undefined
                      }
                      disabled={!writeBackAvailable(draft, conversations)}
                      onClick={() =>
                        setDraft((current) => ({ ...current, can_write_back: true }))
                      }
                    >
                      {t("recipes.writeBackYes")}
                    </button>
                    <button
                      type="button"
                      className={
                        !draft.can_write_back || !writeBackAvailable(draft, conversations)
                          ? "active"
                          : undefined
                      }
                      onClick={() =>
                        setDraft((current) => ({ ...current, can_write_back: false }))
                      }
                    >
                      {t("recipes.writeBackNo")}
                    </button>
                  </div>
                  {!writeBackAvailable(draft, conversations) ? (
                    <p className="recipe-hint">{t("recipes.writeBackUnavailable")}</p>
                  ) : draft.can_write_back ? (
                    <p className="recipe-hint">
                      {t(
                        draft.trigger_kind === "pull"
                          ? "recipes.writeBackHintPull"
                          : "recipes.writeBackHint",
                      )}
                    </p>
                  ) : null}
                </RecipeRow>
                {draft.id ? (
                  <RecipeRow label={t("recipes.enabledCheck")}>
                    <SwitchRow
                      checked={draft.enabled}
                      onChange={(enabled) => setDraft((current) => ({ ...current, enabled }))}
                    >
                      {""}
                    </SwitchRow>
                  </RecipeRow>
                ) : null}
                </div>
              </section>
          </div>

          <div className="recipe-form-foot">
            <label className="recipe-name">
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
            <div className="recipe-actions">
              {draft.id || returnToWork ? (
                <button type="button" className="ghost" onClick={resetDraft}>
                  {t("recipes.cancel")}
                </button>
              ) : null}
              {draft.id ? (
                <>
                  <button
                    type="button"
                    className="ghost"
                    disabled={busy || !draft.enabled || !tryThreadId}
                    title={
                      !draft.enabled
                        ? t("recipes.tryNeedEnabled")
                        : !tryThreadId
                          ? t("recipes.tryNeedChat")
                          : t("recipes.tryTitle")
                    }
                    onClick={() => {
                      void runTryOnce(false);
                    }}
                  >
                    {t("recipes.tryOnce")}
                  </button>
                  {writeBackAvailable(draft, conversations) &&
                  draft.can_write_back ? (
                    <button
                      type="button"
                      className="ghost"
                      disabled={busy || !draft.enabled || !tryThreadId}
                      title={t("recipes.trySendTitle")}
                      onClick={() => {
                        void runTryOnce(true);
                      }}
                    >
                      {t("recipes.tryOnceSend")}
                    </button>
                  ) : null}
                </>
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
            {draft.id && (!draft.enabled || !tryThreadId) ? (
              <p className="muted recipe-try-hint">
                {!draft.enabled
                  ? t("recipes.tryNeedEnabled")
                  : t("recipes.tryNeedChat")}
              </p>
            ) : null}
          </div>
        </form>
      )}
    </section>
  );

  const showGuide = recipes.length === 0 && !draft.id && !returnToWork;

  return (
    <div className="page page-wide page-recipes">
      <header className="page-hero">
        <p className="page-eyebrow">{t("recipes.eyebrow")}</p>
        <h1>{t("recipes.title")}</h1>
        <p className="page-lead">{t("recipes.lead")}</p>
      </header>
      {notice ? <p className="action-ok recipe-page-notice">{notice}</p> : null}
      {error ? <p className="action-error recipe-page-notice">{error}</p> : null}
      {showGuide ? (
        <section className="card recipe-guide">
          <header className="recipe-guide-head">
            <h2>{t("recipes.howTitle")}</h2>
          </header>
          <ol className="recipe-steps">
            <li>
              <strong>{t("recipes.step1Title")}</strong>
              <span>{t("recipes.step1Body")}</span>
            </li>
            <li>
              <strong>{t("recipes.step2Title")}</strong>
              <span>{t("recipes.step2Body")}</span>
            </li>
            <li>
              <strong>{t("recipes.step3Title")}</strong>
              <span>{t("recipes.step3Body")}</span>
            </li>
          </ol>
          {executors.length > 0 ? (
            <div className="recipe-starters">
              <div className="recipe-starters-head">
                <h3>{t("recipes.startersTitle")}</h3>
                <button
                  type="button"
                  className="ghost recipe-import-link"
                  disabled={busy}
                  onClick={() => importRef.current?.click()}
                >
                  {t("recipes.import")}
                </button>
              </div>
              <div className="recipe-starter-grid">
                {(
                  [
                    ["chat", "recipes.starterChat", "recipes.starterChatBody"],
                    ["channel", "recipes.starterChannel", "recipes.starterChannelBody"],
                    ["schedule", "recipes.starterSchedule", "recipes.starterScheduleBody"],
                  ] as const
                ).map(([kind, titleKey, bodyKey]) => (
                  <button
                    key={kind}
                    type="button"
                    className="recipe-starter"
                    onClick={() => applyStarter(kind)}
                  >
                    <strong>{t(titleKey)}</strong>
                    <span>{t(bodyKey)}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </section>
      ) : null}
      {formFirst ? formCard : null}
      {listCard}
      {formFirst ? null : formCard}
      <input
        ref={importRef}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) {
            void importRules(file);
          }
        }}
      />
    </div>
  );
}
