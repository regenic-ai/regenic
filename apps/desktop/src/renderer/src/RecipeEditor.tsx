import { MenuSelect } from "./MenuSelect";
import { RecipeRow } from "./RecipeRow";
import {
  unitKindsForSource,
  withSuggestedName,
  type RecipeDraft,
  type Translate,
} from "./recipe-draft";
import { overlappingPriorityGroup, previewRecipeMatch } from "./recipe-preview";
import type { RecipeSourceOption, ThreadFacet } from "./types";
import { useState, type Dispatch, type SetStateAction } from "react";

export function SwitchRow({
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

export function MatchPreview({
  preview,
  draft,
  t,
}: {
  preview: ReturnType<typeof previewRecipeMatch>;
  draft: RecipeDraft;
  t: Translate;
}) {
  let body: string;
  if (!preview.ready) {
    if (draft.trigger_kind === "pull" || draft.scope === "thread") {
      body = t("recipes.previewNeedChat");
    } else if (draft.scope === "source" && !draft.source.trim()) {
      body = t("recipes.previewNeedSource");
    } else {
      body = t("recipes.previewIncomplete");
    }
  } else if (preview.count === 0) {
    body = t("recipes.previewNone");
  } else if (preview.count === 1) {
    body = t("recipes.previewOne", { name: preview.samples[0] ?? "" });
  } else {
    body = t("recipes.previewMany", { count: preview.count });
  }
  const samples =
    preview.ready && preview.count > 1 && preview.samples.length > 0
      ? t("recipes.previewSamples", { names: preview.samples.join(" · ") })
      : null;
  return (
    <div className="recipe-preview">
      <p className="recipe-preview-body">{body}</p>
      {samples ? <p className="recipe-preview-samples">{samples}</p> : null}
      {preview.ready ? (
        <p className="recipe-hint">{t("recipes.previewPartial")}</p>
      ) : null}
      {preview.preempted_by ? (
        <p className="recipe-preview-conflict">
          {t("recipes.previewConflict", { name: preview.preempted_by })}
        </p>
      ) : null}
    </div>
  );
}

export function PriorityPanel({
  rows,
  t,
}: {
  rows: ReturnType<typeof overlappingPriorityGroup>;
  t: Translate;
}) {
  return (
    <div className="recipe-priority">
      <p className="recipe-preview-title">{t("recipes.priorityTitle")}</p>
      <p className="muted recipe-preview-note">{t("recipes.priorityLead")}</p>
      <ol className="recipe-priority-list">
        {rows.map((row) => (
          <li
            key={row.id}
            className={`recipe-priority-row${row.is_self ? " is-self" : ""}${
              row.enabled ? "" : " is-off"
            }`}
          >
            <span className="recipe-priority-rank">
              {row.enabled
                ? t("recipes.priorityBadge", { rank: row.rank })
                : t("recipes.off")}
            </span>
            <span className="recipe-priority-name">
              {row.is_self
                ? t("recipes.prioritySelf", { name: row.name })
                : row.name}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
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

export function unitKindField(
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
    <RecipeRow label={t("recipes.unitKind")}>
      <MenuSelect
        value={draft.unit_kind}
        placeholder={t("recipes.unitKindAny")}
        options={[{ value: "", label: t("recipes.unitKindAny") }, ...options]}
        onChange={(unit_kind) =>
          setDraft((current) => withSuggestedName({ ...current, unit_kind }))
        }
      />
      <p className="recipe-hint">{t("recipes.unitKindHint")}</p>
    </RecipeRow>
  );
}

export function MoreOptions({
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
    (draft.trigger_kind !== "pull" && draft.include_context) ||
    (draft.trigger_kind !== "pull" && Boolean(draft.max_concurrent.trim()));
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
        <RecipeRow label={t("recipes.facet")}>
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
        </RecipeRow>
        {draft.trigger_kind === "pull" ? (
          <p className="recipe-hint">{t("recipes.includeContextHintPull")}</p>
        ) : (
          <RecipeRow label={t("recipes.includeContextCheck")}>
            <SwitchRow
              checked={draft.include_context}
              onChange={(include_context) =>
                setDraft((current) => ({ ...current, include_context }))
              }
            >
              {""}
            </SwitchRow>
            <p className="recipe-hint">{t("recipes.includeContextHint")}</p>
          </RecipeRow>
        )}
        {draft.trigger_kind === "push" ? (
          <RecipeRow label={t("recipes.coalesceCheck")}>
            <SwitchRow
              checked={draft.coalesce}
              onChange={(coalesce) =>
                setDraft((current) => ({ ...current, coalesce }))
              }
            >
              {""}
            </SwitchRow>
            <p className="recipe-hint">{t("recipes.coalesceHint")}</p>
          </RecipeRow>
        ) : null}
        {draft.trigger_kind !== "pull" ? (
          <RecipeRow label={t("recipes.maxConcurrent")}>
            <input
              type="number"
              min={1}
              inputMode="numeric"
              placeholder={t("recipes.maxConcurrentUnlimited")}
              value={draft.max_concurrent}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  max_concurrent: event.target.value,
                }))
              }
            />
            <p className="recipe-hint">{t("recipes.maxConcurrentHint")}</p>
          </RecipeRow>
        ) : null}
        {draft.can_write_back ? (
          <p className="recipe-hint">{t("recipes.writeBackMatchHint")}</p>
        ) : null}
      </div>
      ) : null}
    </div>
  );
}
