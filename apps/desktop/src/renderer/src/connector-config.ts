export type CatalogOption = {
  value: string;
  label: string;
  kind?: string;
  title?: string;
};

export type CatalogField = {
  key: string;
  options?: CatalogOption[];
  filter_options_by?: string;
  option_labels_key?: string;
};

export function splitValues(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function toggleCsvValue(current: string | undefined, value: string): string {
  const selected = new Set(splitValues(current));
  if (selected.has(value)) {
    selected.delete(value);
  } else {
    selected.add(value);
  }
  return [...selected].join(",");
}

export function optionTitle(option: CatalogOption): string {
  const title = option.title?.replace(/\s+/g, " ").trim();
  if (title && title !== option.value) {
    return title;
  }
  return "";
}

export function filterCatalogFieldOptions(
  field: Pick<CatalogField, "filter_options_by"> | undefined,
  options: CatalogOption[],
  values: Record<string, string>,
): CatalogOption[] {
  const filterKey = field?.filter_options_by;
  if (!filterKey) {
    return options;
  }
  const allowed = new Set(splitValues(values[filterKey]));
  if (allowed.size === 0) {
    return options;
  }
  const typed = options.filter((option) => option.kind);
  if (typed.length === 0) {
    return options;
  }
  if (typed.every((option) => allowed.has(option.kind!))) {
    return options;
  }
  return options.filter((option) => !option.kind || allowed.has(option.kind));
}

/**
 * Free-text catalog fields omit `options`. Do not coalesce to `[]` — an empty
 * array is truthy and the install form would render a dead `<select>`.
 */
export function resolveCatalogFieldOptions(
  field: CatalogField | undefined,
  fieldOptions: CatalogOption[] | undefined,
  remoteOptions: CatalogOption[] | undefined,
  values: Record<string, string>,
): CatalogOption[] | undefined {
  const source = remoteOptions ?? fieldOptions;
  if (!source) {
    return undefined;
  }
  return filterCatalogFieldOptions(field, source, values);
}

export function catalogFieldUsesSelect(
  options: CatalogOption[] | undefined,
): boolean {
  return (options?.length ?? 0) > 0;
}

export function configWithOptionNames(
  values: Record<string, string>,
  fields: CatalogField[],
): Record<string, string> {
  const next = { ...values };
  for (const field of fields) {
    if (field.option_labels_key) {
      delete next[field.option_labels_key];
    }
  }
  for (const field of fields) {
    const labelKey = field.option_labels_key;
    if (!labelKey) {
      continue;
    }
    const ids = splitValues(values[field.key]);
    if (!field.options?.length || ids.length === 0) {
      continue;
    }
    const names = ids.map((id) => {
      const option = field.options?.find((item) => item.value === id);
      return option ? optionTitle(option) : "";
    });
    if (names.every((name) => name.length > 0)) {
      next[labelKey] = names.join(",");
    }
  }
  return next;
}
