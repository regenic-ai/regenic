import {
  DEFAULT_COPY_LOCALE,
  resolveCopy,
  resolveCopyText,
  resolveLocaleHref,
  type CopyLocale,
  type CopyRef,
  type LocaleHref,
  type PluginLocaleTable,
} from "./copy";
import type {
  DriverCatalogField,
  DriverCatalogPrerequisite,
  DriverCatalogSetupStep,
  DriverImportFiles,
  DriverInstallCatalog,
  DriverInstallConfirm,
  DriverInstallPresentation,
} from "./channel-driver";
import type { ExecutorCatalogEntry } from "./executor";
import { readSubjectCatalog, type SubjectCatalog } from "./unit-kind";

export interface ResolvedCatalogField {
  key: string;
  label: string;
  required?: boolean;
  placeholder?: string;
  default?: string;
  multiple?: boolean;
  secret?: boolean;
  options?: { value: string; label: string }[];
  visible_when?: DriverCatalogField["visible_when"];
}

export interface ResolvedCatalogPrerequisite {
  kind: DriverCatalogPrerequisite["kind"];
  key: string;
  label: string;
  required?: boolean;
  hint?: string;
  visible_when?: DriverCatalogPrerequisite["visible_when"];
}

export interface ResolvedCatalogSetupStep {
  title: string;
  body?: string;
  command?: string;
  href?: string;
  visible_when?: DriverCatalogSetupStep["visible_when"];
}

export interface ResolvedImportFiles {
  accept: string;
  max_bytes?: number;
  title?: string;
  description?: string;
}

export interface ResolvedInstallConfirm {
  when: DriverInstallConfirm["when"];
  warning: string;
  ack: string;
}

export interface ResolvedInstallCatalog {
  title: string;
  description: string;
  credential_hint: string;
  channel_label?: string;
  singleton?: boolean;
  fields?: ResolvedCatalogField[];
  prerequisites?: ResolvedCatalogPrerequisite[];
  setup_steps?: ResolvedCatalogSetupStep[];
  install_confirm?: ResolvedInstallConfirm;
  import_files?: ResolvedImportFiles;
  instance_label?: string;
  instance_detail_key?: string;
}

export interface ResolvedInstallPresentation {
  label: string;
  detail: string | null;
}

export function resolveInstallCatalog(
  catalog: DriverInstallCatalog,
  tables: readonly PluginLocaleTable[],
  locale: CopyLocale = DEFAULT_COPY_LOCALE,
): ResolvedInstallCatalog {
  const importFiles = resolveImportFiles(catalog.import_files, tables, locale);
  return {
    title: resolveCopyText(tables, locale, catalog.title),
    description: resolveCopyText(tables, locale, catalog.description),
    credential_hint: resolveCopyText(tables, locale, catalog.credential_hint),
    ...(copyOptional(tables, locale, catalog.channel_label, "channel_label")),
    ...(catalog.singleton ? { singleton: true } : {}),
    fields: (catalog.fields ?? []).map((field) => resolveField(field, tables, locale)),
    prerequisites: (catalog.prerequisites ?? []).map((item) =>
      resolvePrerequisite(item, tables, locale),
    ),
    setup_steps: (catalog.setup_steps ?? []).flatMap((step) => {
      const resolved = resolveSetupStep(step, tables, locale);
      return resolved ? [resolved] : [];
    }),
    ...(catalog.install_confirm
      ? {
          install_confirm: {
            when: catalog.install_confirm.when,
            warning: resolveCopyText(
              tables,
              locale,
              catalog.install_confirm.warning,
            ),
            ack: resolveCopyText(tables, locale, catalog.install_confirm.ack),
          },
        }
      : {}),
    ...(importFiles ? { import_files: importFiles } : {}),
    ...(copyOptional(tables, locale, catalog.instance_label, "instance_label")),
    ...(catalog.instance_detail_key
      ? { instance_detail_key: catalog.instance_detail_key }
      : {}),
  };
}

export function resolveInstallPresentation(
  presented: DriverInstallPresentation,
  tables: readonly PluginLocaleTable[],
  locale: CopyLocale = DEFAULT_COPY_LOCALE,
): ResolvedInstallPresentation {
  return {
    label: resolveCopyText(tables, locale, presented.label),
    detail: resolveCopy(tables, locale, presented.detail ?? undefined) ?? null,
  };
}

export function resolveSubjectKinds(
  catalog: SubjectCatalog | undefined,
  tables: readonly PluginLocaleTable[],
  locale: CopyLocale = DEFAULT_COPY_LOCALE,
): Array<{ id: string; label: string }> {
  return readSubjectCatalog(catalog).kinds.map((kind) => ({
    id: kind.id,
    label: resolveCopyText(tables, locale, kind.label) || kind.id,
  }));
}

export function resolveExecutorCatalog(
  catalog: ExecutorCatalogEntry,
  tables: readonly PluginLocaleTable[],
  locale: CopyLocale = DEFAULT_COPY_LOCALE,
): ExecutorCatalogEntry {
  return {
    ...catalog,
    label: resolveCopyText(tables, locale, catalog.label),
    ...(catalog.description
      ? { description: resolveCopyText(tables, locale, catalog.description) }
      : {}),
    ...(catalog.params_label
      ? { params_label: resolveCopyText(tables, locale, catalog.params_label) }
      : {}),
    fields: catalog.fields.map((field) => ({
      ...field,
      label: resolveCopyText(tables, locale, field.label),
      ...(field.placeholder
        ? { placeholder: resolveCopyText(tables, locale, field.placeholder) }
        : {}),
      ...(field.hint ? { hint: resolveCopyText(tables, locale, field.hint) } : {}),
      ...(field.options
        ? {
            options: field.options.map((option) => ({
              value: option.value,
              label: resolveCopyText(tables, locale, option.label),
            })),
          }
        : {}),
    })),
  };
}

export function resolveFieldOptionLabel(
  label: CopyRef,
  tables: readonly PluginLocaleTable[],
  locale: CopyLocale,
): string {
  return resolveCopyText(tables, locale, label);
}

function resolveField(
  field: DriverCatalogField,
  tables: readonly PluginLocaleTable[],
  locale: CopyLocale,
): ResolvedCatalogField {
  return {
    key: field.key,
    label: resolveCopyText(tables, locale, field.label),
    ...(field.required ? { required: true } : {}),
    ...(copyOptional(tables, locale, field.placeholder, "placeholder")),
    ...(field.default ? { default: field.default } : {}),
    ...(field.multiple ? { multiple: true } : {}),
    ...(field.secret ? { secret: true } : {}),
    ...(field.options
      ? {
          options: field.options.map((option) => ({
            value: option.value,
            label: resolveCopyText(tables, locale, option.label),
          })),
        }
      : {}),
    ...(field.visible_when ? { visible_when: field.visible_when } : {}),
  };
}

function resolvePrerequisite(
  item: DriverCatalogPrerequisite,
  tables: readonly PluginLocaleTable[],
  locale: CopyLocale,
): ResolvedCatalogPrerequisite {
  return {
    kind: item.kind,
    key: item.key,
    label: resolveCopyText(tables, locale, item.label),
    ...(item.required ? { required: true } : {}),
    ...(copyOptional(tables, locale, item.hint, "hint")),
    ...(item.visible_when ? { visible_when: item.visible_when } : {}),
  };
}

function resolveSetupStep(
  step: DriverCatalogSetupStep,
  tables: readonly PluginLocaleTable[],
  locale: CopyLocale,
): ResolvedCatalogSetupStep | undefined {
  const title = resolveCopyText(tables, locale, step.title).replace(/\s+/g, " ").trim();
  if (!title) {
    return undefined;
  }
  const body = resolveCopy(tables, locale, step.body);
  const command = step.command?.trim();
  const href = resolveLocaleHref(step.href as LocaleHref | undefined, locale);
  return {
    title,
    ...(body ? { body } : {}),
    ...(command ? { command } : {}),
    ...(href ? { href } : {}),
    ...(step.visible_when ? { visible_when: step.visible_when } : {}),
  };
}

function resolveImportFiles(
  files: DriverImportFiles | undefined,
  tables: readonly PluginLocaleTable[],
  locale: CopyLocale,
): ResolvedImportFiles | undefined {
  const accept = files?.accept?.replace(/\s+/g, "").trim();
  if (!accept || !files) {
    return undefined;
  }
  return {
    accept,
    ...(typeof files.max_bytes === "number" && files.max_bytes > 0
      ? { max_bytes: files.max_bytes }
      : {}),
    ...(copyOptional(tables, locale, files.title, "title")),
    ...(copyOptional(tables, locale, files.description, "description")),
  };
}

function copyOptional<K extends string>(
  tables: readonly PluginLocaleTable[],
  locale: CopyLocale,
  ref: CopyRef | undefined,
  key: K,
): Partial<Record<K, string>> {
  const text = resolveCopy(tables, locale, ref);
  return text ? ({ [key]: text } as Partial<Record<K, string>>) : {};
}
