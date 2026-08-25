import { useEffect, useMemo, useState } from "react";
import {
  deleteRecipe,
  fetchExecutors,
  fetchRecipes,
  saveRecipe,
} from "./api";
import type {
  ExecutorCatalogEntry,
  RecipeMatch,
  RecipeView,
  RecordClass,
  ThreadFacet,
} from "./types";

const RECORD_CLASSES: Array<{ id: RecordClass | ""; label: string }> = [
  { id: "", label: "Any class" },
  { id: "utterance", label: "Utterance" },
  { id: "task", label: "Task" },
];

const THREAD_FACETS: Array<{ id: ThreadFacet | ""; label: string }> = [
  { id: "", label: "Any facet" },
  { id: "chat", label: "Chat" },
  { id: "agent", label: "Agent" },
  { id: "ticket", label: "Ticket" },
];

export function RecipeSettings({
  sources,
}: {
  sources: Array<{ id: string; label: string }>;
}) {
  const [recipes, setRecipes] = useState<RecipeView[]>([]);
  const [executors, setExecutors] = useState<ExecutorCatalogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<RecipeDraft>(emptyDraft());

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
      setError(caught instanceof Error ? caught.message : "Cannot load recipes");
    });
  }, []);

  const catalog = useMemo(
    () => executors.find((item) => item.executor_type === draft.executor_type),
    [executors, draft.executor_type],
  );

  const save = async () => {
    if (!draft.name.trim() || !draft.executor_type) {
      return;
    }
    const match = draftMatch(draft);
    if (
      !match.thread_id &&
      !match.source &&
      !match.record_class &&
      !match.thread_facet
    ) {
      setError("Pick a source, class, facet, or thread. An empty match never fires.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await saveRecipe(
        {
          name: draft.name.trim(),
          match,
          executor_type: draft.executor_type,
          executor_config: draft.config,
          can_write_back: draft.can_write_back,
          enabled: draft.enabled,
        },
        draft.id,
      );
      setDraft(emptyDraft(executors[0]?.executor_type ?? ""));
      await reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Cannot save recipe");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <h2>Recipes</h2>
      <p className="muted">
        Bind a source, record class, or thread to an installed executor. Classification
        stays on the record, not the connector install. Write-back needs an explicit grant.
      </p>
      {recipes.length === 0 ? (
        <p className="muted">No recipes yet. New matching work stays in the list until you bind one.</p>
      ) : (
        <ul className="recipe-list">
          {recipes.map((recipe) => (
            <li key={recipe.id}>
              <div>
                <strong>{recipe.name}</strong>
                <div className="muted">
                  {recipe.executor_type}
                  {recipe.match.source ? ` · ${recipe.match.source}` : ""}
                  {recipe.match.record_class ? ` · ${recipe.match.record_class}` : ""}
                  {recipe.match.thread_facet ? ` · ${recipe.match.thread_facet}` : ""}
                  {recipe.can_write_back ? " · write-back" : ""}
                  {recipe.enabled ? "" : " · off"}
                </div>
              </div>
              <div className="install-actions">
                <button
                  type="button"
                  className="ghost"
                  onClick={() => setDraft(draftFromRecipe(recipe))}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="ghost"
                  disabled={busy}
                  onClick={() => {
                    if (!window.confirm(`Delete recipe “${recipe.name}”?`)) {
                      return;
                    }
                    void deleteRecipe(recipe.id)
                      .then(reload)
                      .catch((caught: unknown) => {
                        setError(
                          caught instanceof Error ? caught.message : "Cannot delete recipe",
                        );
                      });
                  }}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <form
        className="recipe-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label className="field">
          <span>Name</span>
          <input
            value={draft.name}
            required
            placeholder="Feishu tasks → DSH"
            onChange={(event) =>
              setDraft((current) => ({ ...current, name: event.target.value }))
            }
          />
        </label>
        <label className="field">
          <span>Source</span>
          <select
            value={draft.source}
            onChange={(event) =>
              setDraft((current) => ({ ...current, source: event.target.value }))
            }
          >
            <option value="">Any source</option>
            {sources.map((source) => (
              <option key={source.id} value={source.id}>
                {source.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Record class</span>
          <select
            value={draft.record_class}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                record_class: event.target.value as RecordClass | "",
              }))
            }
          >
            {RECORD_CLASSES.map((item) => (
              <option key={item.id || "any"} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Thread facet</span>
          <select
            value={draft.thread_facet}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                thread_facet: event.target.value as ThreadFacet | "",
              }))
            }
          >
            {THREAD_FACETS.map((item) => (
              <option key={item.id || "any"} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Thread id</span>
          <input
            value={draft.thread_id}
            placeholder="optional source:target"
            onChange={(event) =>
              setDraft((current) => ({ ...current, thread_id: event.target.value }))
            }
          />
        </label>
        <label className="field">
          <span>Executor</span>
          <select
            value={draft.executor_type}
            required
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                executor_type: event.target.value,
                config: {},
              }))
            }
          >
            {executors.length === 0 ? (
              <option value="">No executor installed</option>
            ) : null}
            {executors.map((item) => (
              <option key={item.executor_type} value={item.executor_type}>
                {item.label}
              </option>
            ))}
          </select>
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
          <span>Allow write-back to the source thread</span>
        </label>
        <label className="check-item">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) =>
              setDraft((current) => ({ ...current, enabled: event.target.checked }))
            }
          />
          <span>Enabled</span>
        </label>
        <div className="install-actions">
          {draft.id ? (
            <button
              type="button"
              className="ghost"
              onClick={() => setDraft(emptyDraft(executors[0]?.executor_type ?? ""))}
            >
              Cancel
            </button>
          ) : null}
          <button type="submit" className="primary" disabled={busy || !draft.executor_type}>
            {busy ? "Saving…" : draft.id ? "Update recipe" : "Save recipe"}
          </button>
        </div>
      </form>
      {error ? <p className="action-error">{error}</p> : null}
    </section>
  );
}

interface RecipeDraft {
  id?: string;
  name: string;
  source: string;
  record_class: RecordClass | "";
  thread_facet: ThreadFacet | "";
  thread_id: string;
  executor_type: string;
  config: Record<string, string>;
  can_write_back: boolean;
  enabled: boolean;
}

function emptyDraft(executorType = ""): RecipeDraft {
  return {
    name: "",
    source: "",
    record_class: "",
    thread_facet: "",
    thread_id: "",
    executor_type: executorType,
    config: {},
    can_write_back: false,
    enabled: true,
  };
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
    source: recipe.match.source ?? "",
    record_class: recipe.match.record_class ?? "",
    thread_facet: recipe.match.thread_facet ?? "",
    thread_id: recipe.match.thread_id ?? "",
    executor_type: recipe.executor_type,
    config,
    can_write_back: recipe.can_write_back,
    enabled: recipe.enabled,
  };
}

function draftMatch(draft: RecipeDraft): RecipeMatch {
  return {
    ...(draft.record_class ? { record_class: draft.record_class } : {}),
    ...(draft.thread_facet ? { thread_facet: draft.thread_facet } : {}),
    ...(draft.source.trim() ? { source: draft.source.trim() } : {}),
    ...(draft.thread_id.trim() ? { thread_id: draft.thread_id.trim() } : {}),
  };
}
