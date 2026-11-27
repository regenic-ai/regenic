import { canonicalContextJson } from "./context-canonical";
import type { ContextRequestFilters } from "./context-request";

/** Shared by the lexical and vector indexes. Both already depend on domain, not on the authority store. */
export interface RankedHeadQuery {
  org_id: string;
  authority_path: string;
  filters?: ContextRequestFilters;
  stamp: string;
}

/**
 * Predicate for a current, visible, searchable head.
 * Aliases: source_heads `h`, events `e`, blobs `b`.
 * Time bounds follow the authority read: whole seconds here, exact milliseconds after the shortlist is loaded.
 */
export function authorizedHeadWhere(
  orgId: string,
  filters: ContextRequestFilters | undefined,
): { sql: string; params: unknown[] } {
  const params: unknown[] = [orgId];
  const bind = (value: unknown): string => {
    params.push(value);
    return "?";
  };
  const clauses = [
    "h.org_id = ?",
    "e.operation != 'tombstone'",
    "e.content_hash IS NOT NULL",
    "length(trim(b.media_type)) > 0",
    "json_valid(e.required_scope_ids_json)",
    "json_type(e.required_scope_ids_json) = 'array'",
    "json_array_length(e.required_scope_ids_json) > 0",
    `NOT EXISTS (
      SELECT 1 FROM json_each(e.required_scope_ids_json) AS scope
      WHERE typeof(scope.value) != 'text' OR length(trim(scope.value)) = 0
    )`,
  ];
  for (const [column, values] of [
    ["source", filters?.sources],
    ["thread_id", filters?.thread_ids],
    ["actor_id", filters?.actor_ids],
  ] as const) {
    if (values !== undefined) {
      clauses.push(`e.${column} IN (SELECT value FROM json_each(${bind(JSON.stringify(values))}))`);
    }
  }
  for (const [value, comparison] of [
    [filters?.occurred_after, ">="],
    [filters?.occurred_before, "<="],
  ] as const) {
    if (value !== undefined && Number.isFinite(Date.parse(value))) {
      const second = new Date(Math.floor(Date.parse(value) / 1000) * 1000).toISOString();
      const modifier = comparison === "<=" ? ", '+1 second'" : "";
      clauses.push(`julianday(e.occurred_at) ${comparison} julianday(${bind(second)}${modifier})`);
    }
  }
  const appScope = filters?.app_scope;
  if (appScope) {
    const sourceClause = appScope.agent_sources.length
      ? `e.source IN (SELECT value FROM json_each(${bind(JSON.stringify(appScope.agent_sources))}))`
      : undefined;
    const prefixClauses = appScope.agent_thread_prefixes.map((prefix) => {
      const exact = prefix.endsWith(":")
        ? ` OR e.thread_id = ${bind(prefix.slice(0, -1))}`
        : "";
      return `(e.thread_id IS NOT NULL AND (instr(e.thread_id, ${bind(prefix)}) = 1${exact}))`;
    });
    if (appScope.class === "agent") {
      const parts = [sourceClause, ...prefixClauses].filter((part): part is string => part !== undefined);
      clauses.push(parts.length ? `(${parts.join(" OR ")})` : "(1 = 0)");
    } else {
      if (sourceClause) clauses.push(`NOT (${sourceClause})`);
      for (const prefix of prefixClauses) clauses.push(`NOT ${prefix}`);
    }
  }
  return { sql: clauses.join(" AND "), params };
}

export function authorizedHeadScopeKey(
  stamp: string,
  orgId: string,
  filters: ContextRequestFilters | undefined,
  generation: string,
): string {
  return `${stamp}\0${orgId}\0${generation}\0${canonicalContextJson(filters ?? {})}`;
}

export function authorityHeadFrom(whereSql: string): string {
  return `
    FROM regenic_auth.source_heads h
    JOIN regenic_auth.events e
      ON e.id = h.current_event_id AND e.org_id = h.org_id
    JOIN regenic_auth.blobs b ON b.content_hash = e.content_hash
    WHERE ${whereSql}
  `;
}
