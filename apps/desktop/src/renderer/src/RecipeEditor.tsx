import { MenuSelect } from "./MenuSelect";
import { RecipeRow } from "./RecipeRow";
import { InfoTip } from "./InfoTip";
import {
  unitKindsForSource,
  draftMatch,
  withSuggestedName,
  type RecipeDraft,
  type Translate,
} from "./recipe-draft";
import { overlappingPriorityGroup, previewRecipeMatch, recipeTextMatches } from "./recipe-preview";
import type { RecipeSourceOption } from "./types";
import { useId, useRef, useState, type Dispatch, type SetStateAction } from "react";

type TextFilterKey = "text_contains" | "text_excludes";
const TEXT_FILTER_KEYS: TextFilterKey[] = ["text_contains", "text_excludes"];

export function TextFilterConditions({
  draft,
  setDraft,
  t,
}: {
  draft: RecipeDraft;
  setDraft: Dispatch<SetStateAction<RecipeDraft>>;
  t: Translate;
}) {
  const [added, setAdded] = useState<TextFilterKey[]>([]);
  const [testText, setTestText] = useState("");
  const [testOpen, setTestOpen] = useState(false);
  const inputs = useRef<Partial<Record<TextFilterKey, HTMLInputElement | null>>>({});
  const addControl = useRef<HTMLDivElement>(null);
  const nextFocus = useRef<TextFilterKey | null>(null);
  const id = useId();
  const shown = TEXT_FILTER_KEYS.filter((key) => draft[key] !== "" || added.includes(key));
  const available = TEXT_FILTER_KEYS.filter((key) => !shown.includes(key));
  const complete = shown.length > 0 && shown.every((key) => draft[key].trim());
  const passed = complete && recipeTextMatches(draftMatch(draft), testText);

  const addCondition = (key: string) => {
    if (key !== "text_contains" && key !== "text_excludes") return;
    nextFocus.current = key;
    setAdded((current) => [...current, key]);
  };
  const removeCondition = (key: TextFilterKey) => {
    setDraft((current) => ({ ...current, [key]: "" }));
    setAdded((current) => current.filter((entry) => entry !== key));
    const remaining = shown.find((entry) => entry !== key);
    if (remaining) inputs.current[remaining]?.focus();
    else {
      setTestOpen(false);
      setTestText("");
      requestAnimationFrame(() => addControl.current?.querySelector("button")?.focus());
    }
  };
  if (draft.trigger_kind !== "push") {
    return null;
  }
  return (
    <RecipeRow label={t("recipes.filterConditions")} descriptionId={`${id}-hint`}
      hint={<><p>{t("recipes.filterEmpty")}</p><p>{t("recipes.filterShortHint")}</p><p>{t("recipes.filterHint")}</p></>}>
      <div className={`recipe-conditions${shown.length ? " has-conditions" : ""}`}>
        {shown.length > 0 ? (
          <>
            <div className="recipe-conditions-heading">
              <span>{t("recipes.filterOnlyIf")}</span>
              <span className="recipe-conditions-all">{t("recipes.filterAll")}</span>
            </div>
            <div className="recipe-condition-list">
              {shown.map((key, index) => (
                <div className="recipe-condition-entry" key={key}>
                  {index > 0 ? <span className="recipe-condition-and">{t("recipes.filterAnd")}</span> : null}
                  <div className="recipe-condition">
                    <span className="recipe-condition-field">{t("recipes.filterBody")}</span>
                    <label className="recipe-condition-operator" htmlFor={`${id}-${key}`}>
                      {t(key === "text_contains" ? "recipes.filterOperatorContains" : "recipes.filterOperatorExcludes")}
                    </label>
                    <input
                      id={`${id}-${key}`}
                      ref={(node) => {
                        inputs.current[key] = node;
                        node?.setCustomValidity(draft[key] && !draft[key].trim() ? t("recipes.filterNeedValue") : "");
                        if (node && nextFocus.current === key) {
                          node.focus();
                          nextFocus.current = null;
                        }
                      }}
                      aria-label={t(key === "text_contains" ? "recipes.filterContains" : "recipes.filterExcludes")}
                      aria-describedby={`${id}-hint`}
                      value={draft[key]}
                      required
                      placeholder={t("recipes.filterValuePlaceholder")}
                      onChange={(event) => {
                        const value = event.target.value;
                        event.target.setCustomValidity(value && !value.trim() ? t("recipes.filterNeedValue") : "");
                        setDraft((current) => ({ ...current, [key]: value }));
                      }}
                    />
                    <button
                      type="button"
                      className="recipe-condition-remove"
                      aria-label={t(key === "text_contains" ? "recipes.filterRemoveContains" : "recipes.filterRemoveExcludes")}
                      title={t("recipes.filterRemove")}
                      onClick={() => removeCondition(key)}
                    >
                      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
                        <path d="m4 4 8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                      </svg>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : null}
        <div className="recipe-conditions-actions">
          {available.length ? (
            <div ref={addControl}>
              <MenuSelect
                className="recipe-condition-add"
                value=""
                ariaLabel={t("recipes.filterAdd")}
                placeholder={`+ ${t("recipes.filterAdd")}`}
                options={available.map((key) => ({
                  value: key,
                  label: t(key === "text_contains" ? "recipes.filterContains" : "recipes.filterExcludes"),
                }))}
                onChange={addCondition}
              />
            </div>
          ) : null}
          {shown.length ? (
            <button type="button" className="recipe-condition-test-toggle" aria-expanded={testOpen}
              aria-controls={`${id}-test`} onClick={() => setTestOpen((current) => !current)}>
              {t("recipes.filterTest")}
            </button>
          ) : null}
        </div>
        {testOpen && shown.length ? (
          <div className="recipe-condition-test" id={`${id}-test`}>
            <label htmlFor={`${id}-sample`}>{t("recipes.filterTestLabel")}</label>
            <textarea id={`${id}-sample`} value={testText}
              placeholder={t("recipes.filterTestPlaceholder")}
              onChange={(event) => setTestText(event.target.value)} />
            <p className="recipe-condition-result" role="status" data-result={!complete || !testText ? "idle" : passed ? "pass" : "fail"}>
              {complete && testText ? (
                <span className="recipe-condition-result-icon" aria-hidden="true">{passed ? "\u2713" : "\u00d7"}</span>
              ) : null}
              {t(!complete ? "recipes.filterTestIncomplete" : !testText ? "recipes.filterTestIdle" : passed ? "recipes.filterTestPass" : "recipes.filterTestFail")}
            </p>
            {complete && testText && !passed ? (
              <p className="recipe-hint">
                {!recipeTextMatches({ text_contains: draft.text_contains }, testText)
                  ? t("recipes.filterTestMissing", { text: draft.text_contains })
                  : t("recipes.filterTestExcluded", { text: draft.text_excludes })}
              </p>
            ) : null}
            <span className="recipe-hint">{t("recipes.filterTestSafe")}</span>
          </div>
        ) : null}
      </div>
    </RecipeRow>
  );
}

export function SwitchRow({
  checked,
  onChange,
  children,
  disabled = false,
  label,
  descriptionId,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  children: string;
  disabled?: boolean;
  label?: string;
  descriptionId?: string;
}) {
  return (
    <div className={`switch-row${disabled ? " is-disabled" : ""}`}>
      <span>{children}</span>
      <button
        type="button"
        role="switch"
        aria-label={label ?? children}
        aria-describedby={descriptionId}
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
      <p className="recipe-preview-body">{body}
        {preview.ready ? <>{" "}<InfoTip label={t("recipes.previewTitle")}>
          {t(draft.trigger_kind === "push" && (draft.text_contains.trim() || draft.text_excludes.trim())
            ? "recipes.filterPreviewHint" : "recipes.previewPartial")}
        </InfoTip></> : null}
      </p>
      {samples ? <p className="recipe-preview-samples">{samples}</p> : null}
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
      <p className="recipe-preview-title settings-label">{t("recipes.priorityTitle")}
        <InfoTip label={t("recipes.priorityTitle")}>{t("recipes.priorityLead")}</InfoTip>
      </p>
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
    <RecipeRow label={t("recipes.unitKind")} hint={t("recipes.unitKindHint")}>
      <MenuSelect
        value={draft.unit_kind}
        placeholder={t("recipes.unitKindAny")}
        options={[{ value: "", label: t("recipes.unitKindAny") }, ...options]}
        onChange={(unit_kind) =>
          setDraft((current) => withSuggestedName({ ...current, unit_kind }))
        }
      />
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
  const id = useId();
  const advancedDirty =
    (draft.trigger_kind === "push" && !draft.coalesce) ||
    (draft.trigger_kind !== "pull" && Boolean(draft.max_concurrent.trim())) ||
    draft.hide_on_success;
  const [open, setOpen] = useState(advancedDirty);
  return (
    <div className="recipe-more">
      <button
        type="button"
        className="recipe-more-toggle"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path
            d="M3.5 2 6.5 5l-3 3"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        {t("recipes.advanced")}
      </button>
      {open ? (
      <div className="recipe-more-body">
        <RecipeRow label={t("recipes.hideOnSuccess")} hint={t("recipes.hideOnSuccessHint")}
          descriptionId={`${id}-hide-hint`}>
          <SwitchRow
            label={t("recipes.hideOnSuccess")} descriptionId={`${id}-hide-hint`}
            checked={draft.hide_on_success}
            onChange={(hide_on_success) =>
              setDraft((current) => ({ ...current, hide_on_success }))
            }
          >
            {""}
          </SwitchRow>
        </RecipeRow>
        {draft.trigger_kind === "push" ? (
          <RecipeRow label={t("recipes.coalesceCheck")} hint={t("recipes.coalesceHint")}
            descriptionId={`${id}-coalesce-hint`}>
            <SwitchRow
              label={t("recipes.coalesceCheck")} descriptionId={`${id}-coalesce-hint`}
              checked={draft.coalesce}
              onChange={(coalesce) =>
                setDraft((current) => ({ ...current, coalesce }))
              }
            >
              {""}
            </SwitchRow>
          </RecipeRow>
        ) : null}
        {draft.trigger_kind !== "pull" ? (
          <RecipeRow label={t("recipes.maxConcurrent")} hint={t("recipes.maxConcurrentHint")}
            descriptionId={`${id}-concurrency-hint`}>
            <input
              aria-label={t("recipes.maxConcurrent")} aria-describedby={`${id}-concurrency-hint`}
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
