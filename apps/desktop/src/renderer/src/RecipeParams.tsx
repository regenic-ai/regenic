import { MenuSelect } from "./MenuSelect";
import type { ExecutorCatalogEntry } from "./types";

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
  if (catalog.fields.length === 0) {
    return null;
  }
  return (
    <>
      {catalog.fields.map((field) => {
        const kind = field.kind ?? (field.options?.length ? "select" : "text");
        const value = values[field.key] ?? field.default ?? "";
        return (
          <div key={field.key} className="recipe-row">
            <span className="recipe-row-label">
              {field.label}
              {field.required ? " *" : ""}
            </span>
            <div className="recipe-row-body">
              {kind === "textarea" ? (
                <textarea
                  value={value}
                  placeholder={field.placeholder}
                  required={field.required}
                  rows={5}
                  onChange={(event) => onChange(field.key, event.target.value)}
                />
              ) : kind === "select" ? (
                <MenuSelect
                  value={value}
                  placeholder={field.placeholder}
                  options={field.options ?? []}
                  onChange={(next) => onChange(field.key, next)}
                />
              ) : (
                <input
                  value={value}
                  placeholder={field.placeholder}
                  required={field.required}
                  onChange={(event) => onChange(field.key, event.target.value)}
                />
              )}
              {field.hint ? <p className="recipe-hint">{field.hint}</p> : null}
            </div>
          </div>
        );
      })}
    </>
  );
}
