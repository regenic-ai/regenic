import { MenuSelect } from "./MenuSelect";
import { RecipeRow } from "./RecipeRow";
import { useId } from "react";
import type { ExecutorCatalogEntry } from "./types";

const SHARED_INSTRUCTION_KEYS = new Set(["prompt", "instruction"]);

export { configFromCatalog, invokeCopy } from "./recipe-params";

export function RecipeParams({
  catalog,
  values,
  onChange,
}: {
  catalog: ExecutorCatalogEntry;
  values: Record<string, string>;
  fallbackTitle: string;
  onChange: (key: string, value: string) => void;
}) {
  const id = useId();
  const fields = catalog.fields.filter(
    (field) => !SHARED_INSTRUCTION_KEYS.has(field.key),
  );
  if (fields.length === 0) {
    return null;
  }
  return (
    <>
      {fields.map((field) => {
        const kind = field.kind ?? (field.options?.length ? "select" : "text");
        const value = values[field.key] ?? field.default ?? "";
        const descriptionId = field.hint ? `${id}-${field.key}-hint` : undefined;
        return (
          <RecipeRow key={field.key} label={`${field.label}${field.required ? " *" : ""}`}
            hint={field.hint} descriptionId={descriptionId}>
            {kind === "textarea" ? (
              <textarea
                value={value}
                aria-label={field.label}
                aria-describedby={descriptionId}
                placeholder={field.placeholder}
                required={field.required}
                rows={5}
                onChange={(event) => onChange(field.key, event.target.value)}
              />
            ) : kind === "select" ? (
              <MenuSelect
                value={value}
                ariaLabel={field.label}
                placeholder={field.placeholder}
                options={field.options ?? []}
                onChange={(next) => onChange(field.key, next)}
              />
            ) : (
              <input
                value={value}
                aria-label={field.label}
                aria-describedby={descriptionId}
                placeholder={field.placeholder}
                required={field.required}
                onChange={(event) => onChange(field.key, event.target.value)}
              />
            )}
          </RecipeRow>
        );
      })}
    </>
  );
}
