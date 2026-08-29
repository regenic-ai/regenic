/** Opaque work-unit type stamped by a connector. Kernel equality-matches only. */

export interface UnitKindEntry {
  id: string;
  label: string;
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
  catalogs: ReadonlyArray<{ source?: string; kinds: readonly UnitKindEntry[] }>,
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
    const label =
      typeof record.label === "string" && record.label.trim()
        ? record.label.replace(/\s+/g, " ").trim()
        : id;
    if (!id || !label || seen.has(id)) {
      continue;
    }
    seen.add(id);
    kinds.push({ id, label });
  }
  return { kinds };
}
