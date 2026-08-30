/** Opaque work-unit type stamped by a connector. Kernel equality-matches only. */

import type { CopyRef } from "./copy";

export interface UnitKindEntry {
  id: string;
  label: CopyRef;
}

export interface SubjectCatalog {
  kinds: UnitKindEntry[];
}

export function normalizeUnitKind(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const id = value.trim();
  return id.length > 0 ? id : undefined;
}

export function labelForUnitKind(
  catalogs: ReadonlyArray<{
    source?: string;
    kinds: ReadonlyArray<{ id: string; label: string }>;
  }>,
  source: string | undefined,
  unitKind: string | undefined,
): string | undefined {
  const id = normalizeUnitKind(unitKind);
  if (!id) {
    return undefined;
  }
  const fromSource = catalogs
    .find((catalog) => catalog.source === source)
    ?.kinds.find((kind) => kind.id === id);
  if (fromSource) {
    return fromSource.label;
  }
  for (const catalog of catalogs) {
    const found = catalog.kinds.find((kind) => kind.id === id);
    if (found) {
      return found.label;
    }
  }
  return id;
}

export function readSubjectCatalog(input?: { kinds?: unknown } | null): SubjectCatalog {
  const raw = Array.isArray(input?.kinds) ? input.kinds : [];
  const seen = new Set<string>();
  const kinds: UnitKindEntry[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const record = entry as { id?: unknown; label?: unknown };
    const id = normalizeUnitKind(record.id);
    const label = readCopyRef(record.label) ?? id;
    if (!id || !label || seen.has(id)) {
      continue;
    }
    seen.add(id);
    kinds.push({ id, label });
  }
  return { kinds };
}

function readCopyRef(value: unknown): CopyRef | undefined {
  if (typeof value === "string") {
    const text = value.replace(/\s+/g, " ").trim();
    return text || undefined;
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as { key?: unknown; literal?: unknown; params?: unknown };
  if (typeof record.literal === "string") {
    const text = record.literal.replace(/\s+/g, " ").trim();
    return text ? { literal: text } : undefined;
  }
  if (typeof record.key === "string" && record.key.replace(/\s+/g, " ").trim()) {
    const key = record.key.replace(/\s+/g, " ").trim();
    return typeof record.params === "object" && record.params
      ? { key, params: record.params as Record<string, string | number> }
      : key;
  }
  return undefined;
}
