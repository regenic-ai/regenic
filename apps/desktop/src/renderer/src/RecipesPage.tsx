import {
  deleteRecipe,
  fetchExecutors,
  fetchRecipes,
  saveRecipe,
  tryRecipe,
} from "./api";
import { ChatIcon, ClockIcon, ConnectIcon, FlowIcon, PlusIcon } from "./Icons";
import { useLocale } from "./LocaleContext";
import { MenuSelect } from "./MenuSelect";
import {
  MatchPreview,
  MoreOptions,
  PriorityPanel,
  SwitchRow,
  TextFilterConditions,
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
  workStartErrorCopy,
  parseMaxConcurrent,
  recipeChain,
  recipeToggleInput,
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
  writeBackChoices,
  type RecipeDraft,
  type StarterKind,
} from "./recipe-draft";
import {
  configFromCatalog,
  missingRequiredField,
  taskInstructionValue,
} from "./recipe-params";
import {
  matchingConversations,
  overlappingPriorityGroup,
  previewRecipeMatch,
  shouldConfirmRecipeSave,
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
import { useRecipeConversationCatalog } from "./use-recipe-conversations";
import { useEffect, useMemo, useRef, useState } from "react";

export function RecipesPage({
  sources,
  conversations: initialConversations = [],
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
  const [composing, setComposing] = useState(false);
  const [executors, setExecutors] = useState<ExecutorCatalogEntry[]>([]);
  const [catalogReady, setCatalogReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [returnToWork, setReturnToWork] = useState(() => Boolean(seed));
  const [trySample, setTrySample] = useState("");
  const [filterEditorVersion, setFilterEditorVersion] = useState(0);
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
    setCatalogReady(true);
    setDraft((current) => withCatalogDefaults(current, nextExecutors));
  };

  useEffect(() => {
    void reload().catch((caught: unknown) => {
      setError(caught instanceof Error ? caught.message : t("recipes.loadError"));
    });
  }, [locale, t]);

  const hasRunningRun = recipes.some((recipe) =>
    (recipe.recent_runs?.length
      ? recipe.recent_runs
      : recipe.last_run
        ? [recipe.last_run]
        : []
    ).some((run) => run.status === "running"),
  );

  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "visible") {
        void reload().catch(() => undefined);
      }
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    const timer = hasRunningRun ? window.setInterval(refresh, 15_000) : undefined;
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      if (timer !== undefined) {
        window.clearInterval(timer);
      }
    };
  }, [hasRunningRun]);

  useEffect(() => {
    if (!seed) {
      return;
    }
    setReturnToWork(true);
    setDraft((current) => applySeed(current, seed, current.executor_type));
    setFilterEditorVersion((current) => current + 1);
    setError(null);
    onSeedConsumed?.();
  }, [seed, onSeedConsumed]);

  const catalog = useMemo(
    () => executors.find((item) => item.executor_type === draft.executor_type),
    [executors, draft.executor_type],
  );
  const savedRecipe = draft.id
    ? recipes.find((item) => item.id === draft.id)
    : undefined;
  const taskInstructionRequired =
    !draft.id ||
    Boolean(
      savedRecipe && taskInstructionValue(savedRecipe.executor_config).trim(),
    );
  const taskInstruction = taskInstructionValue(draft.config);
  const suggestedName = suggestedRecipeName(draft, sources, catalog, t);
  const saveBlocker = !draft.executor_type
    ? t("recipes.saveNeedExecutor")
    : taskInstructionRequired && !taskInstruction.trim()
      ? t("recipes.saveNeedInstruction")
      : (draft.scope === "thread" || draft.trigger_kind === "pull") &&
          !draft.thread_id
        ? t("recipes.saveNeedConversation")
        : draft.trigger_kind !== "pull" &&
            draft.scope === "source" &&
            !draft.source.trim()
          ? t("recipes.saveNeedSource")
          : null;
  const executorByType = useMemo(
    () => new Map(executors.map((item) => [item.executor_type, item])),
    [executors],
  );
  const editing = Boolean(draft.id || returnToWork || composing);
  const {
    conversations,
    load: loadConversations,
    ready: conversationsReady,
  } = useRecipeConversationCatalog(initialConversations, editing, locale);
  const awaitingStart = catalogReady && recipes.length === 0 && !editing;
  const conversationOptions = useMemo(
    () => conversationChoices(conversations, draft),
    [conversations, draft.thread_id, draft.thread_title],
  );
  const writeBackOptions = useMemo(
    () => writeBackChoices(draft, conversations, t),
    [conversations, draft, t],
  );
  const canWriteBack = writeBackAvailable(draft, conversations);
  const writeBackUnchanged = savedRecipe?.can_write_back &&
    (savedRecipe.write_back_thread_id ?? "") === draft.write_back_thread_id &&
    (Boolean(draft.write_back_thread_id) ||
      savedRecipe.match.thread_id === draftMatch(draft).thread_id);
  const writeBackAwaitsThread = (draft.scope === "thread" || draft.trigger_kind === "pull") &&
    !draft.thread_id && !draft.write_back_thread_id;
  const writeBackSaveBlocker = draft.can_write_back && !canWriteBack && !writeBackUnchanged &&
    !writeBackAwaitsThread
    ? t(writeBackOptions.length ? "recipes.writeBackUnavailable" : "recipes.writeBackNoTargets")
    : null;
  const writeBackLabel = draft.write_back_thread_id
    ? conversations.find((item) => item.id === draft.write_back_thread_id)?.label ??
      draft.write_back_thread_id
    : t("recipes.writeBackOriginal");
  const matchPreview = useMemo(
    () =>
      previewRecipeMatch({
        match: draftMatch(draft),
        draftId: draft.id,
        triggerKind: draft.trigger_kind,
        conversations: initialConversations,
        recipes,
      }),
    [initialConversations, draft, recipes],
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
        trigger: { kind: draft.trigger_kind },
      },
      recipes,
    );
  }, [draft, recipes, suggestedName, t]);
  const tryChoices = useMemo(() => {
    const match = draftMatch(draft);
    const bound = match.thread_id?.trim();
    if (bound) {
      return [{ id: bound, label: draft.thread_title || bound }];
    }
    return matchingConversations(match, initialConversations, draft.trigger_kind) ?? [];
  }, [draft, initialConversations]);
  const tryThreadId = tryChoices.some((item) => item.id === trySample)
    ? trySample
    : (tryChoices[0]?.id ?? null);

  const payloadFor = (next: RecipeDraft) => ({
    name: (next.name.trim() || suggestedName).trim(),
    match: draftMatch(next),
    trigger: draftTrigger(next),
    executor_type: next.executor_type,
    executor_config: next.config,
    can_write_back: next.can_write_back,
    write_back_thread_id: next.write_back_thread_id || null,
    hide_on_success: next.hide_on_success,
    include_context: next.include_context,
    max_concurrent:
      next.trigger_kind === "pull" ? null : parseMaxConcurrent(next.max_concurrent),
    enabled: next.enabled,
  });
  const dirty =
    !savedRecipe ||
    JSON.stringify(payloadFor(draft)) !==
      JSON.stringify(
        payloadFor(
          draftFromRecipe(
            savedRecipe,
            executorByType.get(savedRecipe.executor_type),
            conversations,
          ),
        ),
      );

  const runTryOnce = async (writeBack: boolean) => {
    if (!draft.id || !tryThreadId) {
      return;
    }
    if (formRef.current?.querySelector("form")?.reportValidity() === false) {
      return;
    }
    const confirmCopy = t(
      writeBack ? "recipes.tryConfirmSend" : "recipes.tryConfirmKeep",
    );
    if (
      !window.confirm(
        dirty ? `${confirmCopy}\n\n${t("recipes.trySavesFirst")}` : confirmCopy,
      )
    ) {
      return;
    }
    if (dirty && !readyToSave()) {
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (dirty) {
        await saveRecipe(payloadFor(draft), draft.id);
      }
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
      setError(workStartErrorCopy(caught, t, t("recipes.tryError")));
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
          write_back_thread_id: item.write_back_thread_id ?? null,
          hide_on_success: item.hide_on_success,
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
    setComposing(false);
    setError(null);
    setNotice(null);
    setDraft(emptyDraftFrom(executors, sources));
    setFilterEditorVersion((current) => current + 1);
  };

  const editRecipe = (recipe: RecipeView) => {
    setFilterEditorVersion((current) => current + 1);
    setReturnToWork(false);
    setError(null);
    setTrySample("");
    setDraft(
      draftFromRecipe(
        recipe,
        executorByType.get(recipe.executor_type),
        conversations,
      ),
    );
    requestAnimationFrame(() => {
      formRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  };

  const toggleRecipe = async (recipe: RecipeView) => {
    setBusy(true);
    setError(null);
    try {
      await saveRecipe(recipeToggleInput(recipe), recipe.id);
      setDraft((current) =>
        current.id === recipe.id
          ? { ...current, enabled: !recipe.enabled }
          : current,
      );
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("recipes.saveError"));
    } finally {
      setBusy(false);
    }
  };

  const openBlank = () => {
    resetDraft();
    setComposing(true);
  };

  const applyStarter = (kind: StarterKind) => {
    setComposing(true);
    setReturnToWork(false);
    setError(null);
    setFilterEditorVersion((current) => current + 1);
    setDraft(
      withSuggestedName(
        starterDraft(kind, emptyDraftFrom(executors, sources), sources, conversations),
      ),
    );
    requestAnimationFrame(() => {
      formRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
  };

  /** Validate and, for broad rules, confirm coverage. False means do not save. */
  const readyToSave = (): boolean => {
    if (formRef.current?.querySelector("form")?.reportValidity() === false) {
      return false;
    }
    if (!draft.executor_type) {
      return false;
    }
    if (taskInstructionRequired && !taskInstructionValue(draft.config).trim()) {
      setError(t("recipes.saveNeedInstruction"));
      return false;
    }
    if (writeBackSaveBlocker) {
      setError(writeBackSaveBlocker);
      return false;
    }
    const match = draftMatch(draft);
    if (!canAutoStart(match, draft)) {
      setError(scopeError(draft, t));
      return false;
    }
    const required = missingRequiredField(catalog, draft.config);
    if (required) {
      setError(t("recipes.errRequired", { field: required }));
      return false;
    }
    const writeBack = draft.can_write_back;
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
        return false;
      }
    }
    return true;
  };

  const save = async () => {
    if (!readyToSave()) {
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await saveRecipe(payloadFor(draft), draft.id);
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
            <button
              type="button"
              className="primary"
              disabled={busy || executors.length === 0}
              onClick={openBlank}
            >
              {t("recipes.new")}
            </button>
          </div>
        </div>
        <ul className="recipe-list">
          {recipes.map((recipe) => {
            const next = nextRunCopy(recipe, t);
            const last = lastRunCopy(recipe, t);
            const conflict = conflictCopy(recipe, recipes, t);
            const summary = recipeChain(
              recipe,
              sources,
              conversations,
              executorByType.get(recipe.executor_type)?.label ??
                recipe.executor_type,
              t,
            )
              .map((step) => step.label)
              .filter(Boolean)
              .join(" · ");
            const meta = [next, last].filter(Boolean).join(" · ");
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
                    <strong title={recipe.name}>{recipe.name}</strong>
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
                  {summary ? (
                    <span className="recipe-card-summary" title={summary}>
                      {summary}
                    </span>
                  ) : null}
                  {meta ? <span className="recipe-card-next">{meta}</span> : null}
                  {conflict ? (
                    <span className="recipe-card-next is-conflict">{conflict}</span>
                  ) : null}
                </button>
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
                      setBusy(true);
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
                        })
                        .finally(() => setBusy(false));
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
        <button
          type="button"
          className="ghost recipe-back"
          onClick={resetDraft}
        >
          {t("recipes.backToList")}
        </button>
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
                  <span className="recipe-step-no" aria-hidden="true">1</span>
                  <h3>{t("recipes.stageTrigger")}</h3>
                </header>
                <div className="recipe-rows">
                <RecipeRow label={t("recipes.triggerRow")} hint={triggerHint(draft.trigger_kind, t)}>
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
                </RecipeRow>
                {draft.trigger_kind === "pull" ? (
                  <RecipeRow label={t("recipes.interval")} hint={t("recipes.scheduleInstructionsHint")}>
                    <ScheduleField
                      draft={draft}
                      t={t}
                      onChange={(patch) =>
                        setDraft((current) => ({ ...current, ...patch }))
                      }
                    />
                  </RecipeRow>
                ) : null}
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
                    <MenuSelect
                      value={draft.thread_id}
                      valueLabel={draft.thread_title || draft.thread_id || undefined}
                      placeholder={t("recipes.chooseConversation")}
                      ariaLabel={t("recipes.conversation")}
                      searchable
                      onLoad={loadConversations}
                      resultsReady={conversationsReady}
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
                          }),
                        );
                      }}
                    />
                  </RecipeRow>
                ) : null}

                </div>
              </section>

              <section className="recipe-section">
                <header className="recipe-section-head">
                  <span className="recipe-step-no" aria-hidden="true">2</span>
                  <h3>{t("recipes.stageScope")}</h3>
                </header>
                <div className="recipe-rows">
                <TextFilterConditions key={`${draft.id ?? "new"}:${filterEditorVersion}`} draft={draft} setDraft={setDraft} t={t} />
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
                  <span className="recipe-step-no" aria-hidden="true">3</span>
                  <h3>{t("recipes.stageHandler")}</h3>
                </header>
                <div className="recipe-rows">
                <RecipeRow label={t("recipes.runWith")} hint={catalog?.description}>
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
                              current.config,
                            ),
                          }),
                        )
                      }
                    />
                  )}
                </RecipeRow>
                <RecipeRow label={t("recipes.instruction")} hint={t("recipes.instructionHint")}
                  descriptionId="recipe-instruction-hint">
                  <textarea
                    aria-label={t("recipes.instruction")} aria-describedby="recipe-instruction-hint"
                    value={taskInstruction}
                    placeholder={t("recipes.instructionPlaceholder")}
                    required={taskInstructionRequired}
                    rows={5}
                    onChange={(event) =>
                      setDraft((current) => {
                        const config: Record<string, string> = {
                          ...current.config,
                          prompt: event.target.value,
                        };
                        delete config.instruction;
                        return { ...current, config };
                      })
                    }
                  />
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
                <RecipeRow label={t("recipes.includeContextCheck")} descriptionId="recipe-context-hint"
                  hint={t(draft.trigger_kind === "pull" ? "recipes.includeContextHintPull" : "recipes.includeContextHint")}>
                  {draft.trigger_kind === "pull" ? (
                    <p className="recipe-chip">{t("recipes.contextIncluded")}</p>
                  ) : (
                    <>
                      <SwitchRow
                        label={t("recipes.includeContextCheck")} descriptionId="recipe-context-hint"
                        checked={draft.include_context}
                        onChange={(include_context) =>
                          setDraft((current) => ({ ...current, include_context }))
                        }
                      >
                        {""}
                      </SwitchRow>
                    </>
                  )}
                </RecipeRow>
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
                  <span className="recipe-step-no" aria-hidden="true">4</span>
                  <h3>{t("recipes.stageDestination")}</h3>
                </header>
                <div className="recipe-rows">
                <RecipeRow label={t("recipes.result")}>
                  <div className="seg" role="group" aria-label={t("recipes.result")}>
                    <button
                      type="button"
                      className={draft.can_write_back ? "active" : undefined}
                      aria-pressed={draft.can_write_back}
                      onClick={() =>
                        setDraft((current) => ({ ...current, can_write_back: true }))
                      }
                    >
                      {t("recipes.writeBackYes")}
                    </button>
                    <button
                      type="button"
                      className={!draft.can_write_back ? "active" : undefined}
                      aria-pressed={!draft.can_write_back}
                      onClick={() =>
                        setDraft((current) => ({ ...current, can_write_back: false }))
                      }
                    >
                      {t("recipes.writeBackNo")}
                    </button>
                  </div>
                </RecipeRow>
                {draft.can_write_back ? (
                  <RecipeRow label={t("recipes.writeBackTo")}>
                    <MenuSelect
                      value={draft.write_back_thread_id}
                      options={writeBackOptions}
                      valueLabel={writeBackAwaitsThread
                        ? t("recipes.writeBackOriginal")
                        : draft.write_back_thread_id || writeBackOptions.length || writeBackUnchanged
                          ? t("recipes.writeBackTargetUnavailable", { name: writeBackLabel })
                          : t("recipes.writeBackNoTargets")}
                      placeholder={t("recipes.searchConversation")}
                      searchable
                      onLoad={loadConversations}
                      resultsReady={conversationsReady}
                      ariaLabel={t("recipes.writeBackTo")}
                      onChange={(write_back_thread_id) =>
                        setDraft((current) => ({ ...current, write_back_thread_id }))
                      }
                    />
                    {writeBackAwaitsThread ? (
                      <p className="recipe-hint">{t("recipes.writeBackHint")}</p>
                    ) : !canWriteBack && (writeBackOptions.length > 0 || draft.write_back_thread_id || writeBackUnchanged) ? (
                      <p className="recipe-hint" role="status">
                        {t(writeBackOptions.length
                          ? "recipes.writeBackUnavailable"
                          : "recipes.writeBackNoTargets")}
                        {writeBackUnchanged ? <> {t("recipes.writeBackPreserved")}</> : null}
                      </p>
                    ) : canWriteBack ? (
                      <p className="recipe-hint">
                        {t(draft.write_back_thread_id
                          ? "recipes.writeBackHintSelected"
                          : draft.trigger_kind === "pull"
                            ? "recipes.writeBackHintPull"
                            : "recipes.writeBackHint")}
                      </p>
                    ) : null}
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
            <div className="recipe-enabled" title={draft.enabled ? undefined : t("recipes.enabledOffHint")}>
              <SwitchRow
                label={t("recipes.enabledCheck")}
                checked={draft.enabled}
                onChange={(enabled) => setDraft((current) => ({ ...current, enabled }))}
              >
                {t("recipes.enabledCheck")}
              </SwitchRow>
            </div>
            <div className="recipe-actions">
              {draft.id || returnToWork || composing ? (
                <button
                  type="button"
                  className="ghost"
                  onClick={resetDraft}
                >
                  {t("recipes.cancel")}
                </button>
              ) : null}
              {draft.id && tryChoices.length > 1 ? (
                <label className="recipe-try-sample">
                  <span>{t("recipes.trySample")}</span>
                  <MenuSelect
                    value={tryThreadId ?? ""}
                    options={tryChoices.map((item) => ({
                      value: item.id,
                      label: item.label,
                    }))}
                    onChange={setTrySample}
                  />
                </label>
              ) : null}
              {draft.id ? (
                <button
                  type="button"
                  className="ghost"
                  disabled={busy || !tryThreadId}
                  title={
                    !tryThreadId
                      ? t("recipes.tryNeedChat")
                      : dirty
                        ? `${t("recipes.tryTitle")} · ${t("recipes.trySavesFirst")}`
                        : t("recipes.tryTitle")
                  }
                  onClick={() => {
                    void runTryOnce(false);
                  }}
                >
                  {t("recipes.tryOnce")}
                </button>
              ) : null}
              {draft.id &&
              draft.can_write_back &&
              tryThreadId ? (
                <button
                  type="button"
                  className="ghost"
                  disabled={busy || !writeBackAvailable(draft, conversations, tryThreadId)}
                  title={t(writeBackAvailable(draft, conversations, tryThreadId)
                    ? "recipes.trySendTitle" : "recipes.writeBackUnavailable")}
                  onClick={() => {
                    void runTryOnce(true);
                  }}
                >
                  {t("recipes.tryOnceSend")}
                </button>
              ) : null}
              <button
                type="submit"
                className="primary"
                disabled={busy || Boolean(saveBlocker || writeBackSaveBlocker)}
                title={saveBlocker ?? writeBackSaveBlocker ?? undefined}
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
            {saveBlocker ? (
              <p className="muted recipe-try-hint is-blocking" role="status">
                {saveBlocker}
              </p>
            ) : !draft.id ? (
              <p className="muted recipe-try-hint">{t("recipes.tryNeedSave")}</p>
            ) : !tryThreadId ? (
              <p className="muted recipe-try-hint">{t("recipes.tryNeedChat")}</p>
            ) : null}
          </div>
        </form>
      )}
    </section>
  );

  const showGuide = awaitingStart;

  return (
    <div className="page page-wide page-recipes">
      <header className="page-hero">
        <p className="page-eyebrow">{t("recipes.eyebrow")}</p>
        <h1>{t("recipes.title")}</h1>
        <p className="page-lead">{t("recipes.lead")}</p>
      </header>
      {notice ? <p className="action-ok recipe-page-notice">{notice}</p> : null}
      {error ? <p className="action-error recipe-page-notice">{error}</p> : null}
      {showGuide && executors.length === 0 ? (
        <section className="recipe-empty">
          <span className="recipe-empty-icon"><FlowIcon /></span>
          <h2>{t("recipes.noAgentTitle")}</h2>
          <p>{t("recipes.noExecutor")}</p>
          {onGoEngine ? (
            <button type="button" className="primary" onClick={onGoEngine}>
              {t("recipes.goEngine")}
            </button>
          ) : null}
        </section>
      ) : null}
      {showGuide && executors.length > 0 ? (
        <section className="recipe-start">
          <div className="recipe-start-head">
            <h2>{t("recipes.startersTitle")}</h2>
            <div className="recipe-start-actions">
              <button
                type="button"
                className="ghost"
                disabled={busy}
                onClick={() => importRef.current?.click()}
              >
                {t("recipes.import")}
              </button>
              <button type="button" className="primary" onClick={openBlank}>
                <PlusIcon />
                {t("recipes.startBlank")}
              </button>
            </div>
          </div>
          <div className="recipe-template-grid">
            {(
              [
                ["chat", ChatIcon, "recipes.starterChat", "recipes.starterChatBody",
                  ["recipes.flow.newMessage", "recipes.flow.agent", "recipes.flow.backToChat"]],
                ["channel", ConnectIcon, "recipes.starterChannel", "recipes.starterChannelBody",
                  ["recipes.flow.newTask", "recipes.flow.agent", "recipes.flow.backToSource"]],
                ["schedule", ClockIcon, "recipes.starterSchedule", "recipes.starterScheduleBody",
                  ["recipes.flow.hourly", "recipes.flow.agent", "recipes.flow.backToChat"]],
              ] as const
            ).map(([kind, Icon, titleKey, bodyKey, flow]) => (
              <button
                key={kind}
                type="button"
                className="recipe-template"
                onClick={() => applyStarter(kind)}
              >
                <span className="recipe-template-icon"><Icon /></span>
                <strong>{t(titleKey)}</strong>
                <span className="recipe-template-body">{t(bodyKey)}</span>
                <span className="recipe-template-flow">
                  {flow.map((step, index) => (
                    <span key={step}>
                      {index > 0 ? <span className="recipe-flow-arrow" aria-hidden="true">→</span> : null}
                      <span className="recipe-flow-chip">{t(step)}</span>
                    </span>
                  ))}
                </span>
              </button>
            ))}
          </div>
          <ol className="recipe-how" aria-label={t("recipes.howTitle")}>
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
        </section>
      ) : null}
      {editing ? formCard : listCard}
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
