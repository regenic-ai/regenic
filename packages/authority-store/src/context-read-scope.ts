import type { ContextAuthorityReadQuery } from "@regenic/domain";

export function contextReadScope(
  orgId: string,
  query: ContextAuthorityReadQuery | undefined,
  dialect: "sqlite" | "postgres",
): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const bind = (value: unknown): string => {
    params.push(value);
    return dialect === "sqlite" ? "?" : `$${params.length}`;
  };
  const conditions = [`s.org_id = ${bind(orgId)}`];
  for (const [column, values] of [
    ["source", query?.filters?.sources],
    ["thread_id", query?.filters?.thread_ids],
    ["actor_id", query?.filters?.actor_ids],
  ] as const) {
    if (values !== undefined) {
      conditions.push(dialect === "sqlite"
        ? `s.${column} IN (SELECT value FROM json_each(${bind(JSON.stringify(values))}))`
        : `s.${column} = ANY(${bind(values)}::text[])`);
    }
  }
  for (const [value, comparison] of [
    [query?.filters?.occurred_after, ">="],
    [query?.filters?.occurred_before, "<="],
  ] as const) {
    if (value !== undefined) {
      // Preselect whole seconds; retrieval enforces Date.parse's exact millisecond bounds.
      const second = new Date(Math.floor(Date.parse(value) / 1000) * 1000).toISOString();
      conditions.push(dialect === "sqlite"
        ? `julianday(s.occurred_at) ${comparison} julianday(${bind(second)}${comparison === "<=" ? ", '+1 second'" : ""})`
        : `s.occurred_at ${comparison} (${bind(second)}::timestamptz${comparison === "<=" ? " + INTERVAL '1 second'" : ""})`);
    }
  }
  if (query?.anchors?.length) {
    const anchors = query.anchors.map((anchor) => {
      if (anchor.kind === "event") return `s.id = ${bind(anchor.id)}`;
      if (anchor.kind === "conversation") return `s.thread_id = ${bind(anchor.id)}`;
      return dialect === "sqlite"
        ? `(json_type(s.attrs_json, ${bind(`$.${anchor.kind}_id`)}) = 'text'
            AND json_extract(s.attrs_json, ${bind(`$.${anchor.kind}_id`)}) = ${bind(anchor.id)})`
        : `(jsonb_typeof(s.attrs -> ${bind(`${anchor.kind}_id`)}) = 'string'
            AND s.attrs ->> ${bind(`${anchor.kind}_id`)} = ${bind(anchor.id)})`;
    });
    conditions.push(`(${anchors.join(" OR ")})`);
  }
  return {
    sql: `WITH selected_identities AS (
      SELECT DISTINCT s.org_id, s.source, s.external_id
      FROM events s WHERE ${conditions.join(" AND ")}
    )`,
    params,
  };
}
