import { MenuSelect } from "./MenuSelect";
import type { ExecutorCatalogEntry } from "./types";

export { configFromCatalog, invokeCopy } from "./recipe-params";

export function RecipeParams({
  catalog,
  values,
  fallbackTitle,
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
    <fieldset className="recipe-params">
      <legend>{catalog.params_label ?? fallbackTitle}</legend>
      {catalog.description ? (
        <p className="recipe-params-lead">{catalog.description}</p>
      ) : null}
      {catalog.fields.map((field) => {
        const kind = field.kind ?? (field.options?.length ? "select" : "text");
        const value = values[field.key] ?? field.default ?? "";
        return (
          <div
            key={field.key}
            className={`field${kind === "textarea" ? " field-wide" : ""}`}
          >
            <span>
              {field.label}
              {field.required ? " *" : ""}
            </span>
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
            {field.hint ? <span className="muted">{field.hint}</span> : null}
          </div>
        );
      })}
    </fieldset>
  );
}
