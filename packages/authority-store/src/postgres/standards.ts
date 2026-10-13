import type {
  StandardRecord,
  StandardVersionRecord,
  StandardVersionTransition,
  StandardGapRecord,
  StandardGapStatus,
  StandardUsageSourceKind,
  StandardUsageRecord,
  DecisionRecord,
  ListSyncWorkGapsOptions,
  SyncWorkGap,
  StandardVersionState,
} from "@regenic/domain";
import {
  transitionStandardVersion as applyStandardVersionTransition,
  validateStandardGap,
  canonicalContextJson,
  validateDecision,
  validateStandardUsage,
  STANDARD_USAGE_SCHEMA_VERSION,
  hashCanonicalContext,
  SYNC_CATALOG_STREAM,
  validateStandard,
  validateStandardVersion,
} from "@regenic/domain";
import {
  PgSql,
  jsonb,
  toIso,
} from "./sql";
import {
  parseContextJson,
} from "./context-artifacts";
import {
  AgentRunRow,
  toAgentRun,
} from "./agent-runs";

export async function getStandard(db: PgSql, orgId: string, standardId: string): Promise<StandardRecord | null> {
    const row = await db.queryOne<StandardRow>(`SELECT payload_json, current_version_id, citation_count FROM standards WHERE org_id = $1 AND id = $2`, [orgId, standardId]);
    return row ? toStandard(row) : null;
  }

export async function getStandardBySlug(db: PgSql, orgId: string, slug: string): Promise<StandardRecord | null> {
    const row = await db.queryOne<StandardRow>(`SELECT payload_json, current_version_id, citation_count FROM standards WHERE org_id = $1 AND slug = $2`, [orgId, slug]);
    return row ? toStandard(row) : null;
  }

export async function listStandards(db: PgSql, input: {
    org_id: string;
    limit?: number;
    after_created_at?: string;
    after_id?: string;
  }): Promise<StandardRecord[]> {
    const hasCursor = !!input.after_created_at && !!input.after_id;
    const rows = await db.query<StandardRow>(
      `SELECT payload_json, current_version_id, citation_count FROM standards
       WHERE org_id = $1${hasCursor ? " AND (created_at > $2 OR (created_at = $2 AND id > $3))" : ""}
       ORDER BY created_at, id LIMIT $${hasCursor ? 4 : 2}`,
      hasCursor
        ? [input.org_id, input.after_created_at!, input.after_id!, input.limit ?? 100]
        : [input.org_id, input.limit ?? 100],
    );
    return rows.map(toStandard);
  }

export async function getStandardVersion(db: PgSql, orgId: string, versionId: string): Promise<StandardVersionRecord | null> {
    const row = await db.queryOne<StandardVersionRow>(`SELECT status, payload_json, state_json FROM standard_versions WHERE org_id = $1 AND id = $2`, [orgId, versionId]);
    return row ? toStandardVersion(row) : null;
  }

export async function listStandardVersions(db: PgSql, input: { org_id: string; standard_id: string; limit?: number }): Promise<StandardVersionRecord[]> {
    const rows = await db.query<StandardVersionRow>(`SELECT status, payload_json, state_json FROM standard_versions WHERE org_id = $1 AND standard_id = $2 ORDER BY created_at, id LIMIT $3`, [input.org_id, input.standard_id, input.limit ?? 100]);
    return rows.map(toStandardVersion);
  }

export async function transitionStandardVersion(db: PgSql, input: StandardVersionTransition): Promise<StandardVersionRecord | null> {
    return db.withTx(async (client) => {
      const row = await db.queryOne<StandardVersionRow>(`SELECT status, payload_json, state_json FROM standard_versions WHERE org_id = $1 AND id = $2 FOR UPDATE`, [input.org_id, input.version_id], client);
      if (!row) return null;
      const current = toStandardVersion(row);
      const standardRow = await db.queryOne<StandardRow>(`SELECT payload_json, current_version_id, citation_count FROM standards WHERE org_id = $1 AND id = $2 FOR UPDATE`, [input.org_id, current.standard_id], client);
      if (!standardRow) throw new Error("Standard was not found");
      const standard = toStandard(standardRow);
      if (input.superseded_by_version_id) {
        const replacementRow = await db.queryOne<StandardVersionRow>(`SELECT status, payload_json, state_json FROM standard_versions WHERE org_id = $1 AND id = $2`, [input.org_id, input.superseded_by_version_id], client);
        const replacement = replacementRow ? toStandardVersion(replacementRow) : null;
        if (!replacement || replacement.standard_id !== current.standard_id || replacement.status !== "active") {
          throw new Error("StandardVersion replacement must be active in the same Standard");
        }
      }
      const next = applyStandardVersionTransition(current, standard, input);
      await db.execute(`UPDATE standard_versions SET status = $1, state_json = $2 WHERE org_id = $3 AND id = $4 AND status = $5`, [next.status, jsonb(standardVersionState(next)), input.org_id, input.version_id, current.status], client);
      if (next.status === "trial" || next.status === "active") {
        await db.execute(`UPDATE standards SET current_version_id = $1 WHERE org_id = $2 AND id = $3`, [next.id, input.org_id, standard.id], client);
      } else if (next.superseded_by_version_id) {
        await db.execute(`UPDATE standards SET current_version_id = $1 WHERE org_id = $2 AND id = $3 AND current_version_id = $4`, [next.superseded_by_version_id, input.org_id, standard.id, next.id], client);
      }
      return next;
    });
  }

export async function putStandardGap(db: PgSql, input: StandardGapRecord): Promise<StandardGapRecord> {
    const gap = validateStandardGap(input);
    if (gap.status !== "open") throw new Error("New StandardGap must be open");
    await db.execute(`INSERT INTO standard_gaps (id, org_id, source_kind, source_ref, status, payload_json, converted_proposal_id, created_at, updated_at) VALUES ($1, $2, $3, $4, 'open', $5, NULL, $6, $7) ON CONFLICT DO NOTHING`, [gap.id, gap.org_id, gap.source_kind, gap.source_ref, jsonb(gap), gap.created_at, gap.updated_at]);
    const row = await db.queryOne<StandardGapRow>(`SELECT status, payload_json, converted_proposal_id, updated_at FROM standard_gaps WHERE org_id = $1 AND source_kind = $2 AND source_ref = $3`, [gap.org_id, gap.source_kind, gap.source_ref]);
    if (!row) throw new Error("Cannot persist StandardGap");
    const storedCreation = validateStandardGap(parseContextJson<StandardGapRecord>(row.payload_json));
    if (canonicalContextJson(storedCreation) !== canonicalContextJson({
      ...gap,
      id: storedCreation.id,
      created_at: storedCreation.created_at,
      updated_at: storedCreation.updated_at,
    })) throw new Error("Cannot replace immutable StandardGap");
    return toStandardGap(row);
  }

export async function getStandardGap(db: PgSql, orgId: string, gapId: string): Promise<StandardGapRecord | null> {
    const row = await db.queryOne<StandardGapRow>(`SELECT status, payload_json, converted_proposal_id, updated_at FROM standard_gaps WHERE org_id = $1 AND id = $2`, [orgId, gapId]);
    return row ? toStandardGap(row) : null;
  }

export async function listStandardGaps(db: PgSql, input: { org_id: string; status?: StandardGapStatus; limit?: number }): Promise<StandardGapRecord[]> {
    const rows = await db.query<StandardGapRow>(`SELECT status, payload_json, converted_proposal_id, updated_at FROM standard_gaps WHERE org_id = $1 ${input.status ? "AND status = $2" : ""} ORDER BY created_at, id LIMIT $${input.status ? 3 : 2}`, input.status ? [input.org_id, input.status, input.limit ?? 100] : [input.org_id, input.limit ?? 100]);
    return rows.map(toStandardGap);
  }

export async function dismissStandardGap(db: PgSql, input: { org_id: string; gap_id: string; dismissed_at: string }): Promise<StandardGapRecord | null> {
    if (!input.org_id?.trim() || !input.gap_id?.trim() || Number.isNaN(Date.parse(input.dismissed_at))) throw new Error("Invalid StandardGap dismissal");
    return db.withTx(async (client) => {
      const row = await db.queryOne<StandardGapRow>(`SELECT status, payload_json, converted_proposal_id, updated_at FROM standard_gaps WHERE org_id = $1 AND id = $2 FOR UPDATE`, [input.org_id, input.gap_id], client);
      if (!row) return null;
      const gap = toStandardGap(row);
      if (gap.status === "converted") throw new Error("Converted StandardGap cannot be dismissed");
      if (gap.status === "dismissed") return gap;
      if (Date.parse(input.dismissed_at) < Date.parse(gap.created_at)) throw new Error("Invalid StandardGap dismissal");
      await db.execute(`UPDATE standard_gaps SET status = 'dismissed', updated_at = $1 WHERE org_id = $2 AND id = $3 AND status = 'open'`, [input.dismissed_at, input.org_id, input.gap_id], client);
      return validateStandardGap({ ...gap, status: "dismissed", updated_at: input.dismissed_at });
    });
  }

export async function projectStandardUsage(db: PgSql, input: { org_id: string; source_kind: StandardUsageSourceKind; source_id: string }): Promise<StandardUsageRecord[]> {
    if (!input.org_id?.trim() || !input.source_id?.trim() || !["decision", "agent_run"].includes(input.source_kind)) {
      throw new Error("Invalid StandardUsage projection");
    }
    return db.withTx(async (client) => {
      let bindings: Array<{ standard_id: string; version_id: string }>;
      let contextSnapshotId: string;
      let citedAt: string;
      if (input.source_kind === "decision") {
        const row = await db.queryOne<{ payload_json: unknown }>(`SELECT payload_json FROM decisions WHERE org_id = $1 AND id = $2`, [input.org_id, input.source_id], client);
        if (!row) throw new Error("StandardUsage source Decision was not found");
        const decision = validateDecision(parseContextJson<DecisionRecord>(row.payload_json));
        bindings = decision.standard_bindings;
        contextSnapshotId = decision.context_snapshot_id;
        citedAt = decision.committed_at;
      } else {
        const row = await db.queryOne<AgentRunRow>(`SELECT status, payload_json, state_json FROM agent_runs WHERE org_id = $1 AND id = $2`, [input.org_id, input.source_id], client);
        if (!row) throw new Error("StandardUsage source AgentRun was not found");
        const run = toAgentRun(row);
        bindings = run.standard_bindings;
        contextSnapshotId = run.context_snapshot_id;
        citedAt = run.created_at;
      }
      for (const standardId of [...new Set(bindings.map(({ standard_id }) => standard_id))].sort()) {
        const locked = await db.queryOne<{ id: string }>(`SELECT id FROM standards WHERE org_id = $1 AND id = $2 FOR UPDATE`, [input.org_id, standardId], client);
        if (!locked) throw new Error("StandardUsage binding was not found");
      }
      const usages: StandardUsageRecord[] = [];
      for (const binding of bindings) {
        const standardRow = await db.queryOne<StandardRow>(`SELECT payload_json, current_version_id, citation_count FROM standards WHERE org_id = $1 AND id = $2`, [input.org_id, binding.standard_id], client);
        const versionRow = await db.queryOne<StandardVersionRow>(`SELECT status, payload_json, state_json FROM standard_versions WHERE org_id = $1 AND id = $2`, [input.org_id, binding.version_id], client);
        const standard = standardRow ? toStandard(standardRow) : null;
        const version = versionRow ? toStandardVersion(versionRow) : null;
        if (!standard || !version || version.standard_id !== standard.id) {
          throw new Error("StandardUsage binding was not found");
        }
        const usage = validateStandardUsage({
          schema_version: STANDARD_USAGE_SCHEMA_VERSION,
          id: `standard-usage:${hashCanonicalContext([
            input.org_id, input.source_kind, input.source_id, standard.id, version.id,
          ])}`,
          org_id: input.org_id,
          standard_id: standard.id,
          version_id: version.id,
          source_kind: input.source_kind,
          source_id: input.source_id,
          context_snapshot_id: contextSnapshotId,
          cited_at: citedAt,
        });
        await db.execute(`INSERT INTO standard_usage (id, org_id, standard_id, version_id, source_kind, source_id, context_snapshot_id, cited_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`, [usage.id, usage.org_id, usage.standard_id, usage.version_id, usage.source_kind, usage.source_id, usage.context_snapshot_id, usage.cited_at], client);
        usages.push(usage);
      }
      for (const standardId of new Set(usages.map(({ standard_id }) => standard_id))) {
        await db.execute(`UPDATE standards SET citation_count = (SELECT COUNT(*) FROM standard_usage WHERE org_id = $1 AND standard_id = $2) WHERE org_id = $1 AND id = $2`, [input.org_id, standardId], client);
      }
      return usages;
    });
  }

export async function listStandardUsage(db: PgSql, input: { org_id: string; standard_id?: string; version_id?: string; source_kind?: StandardUsageSourceKind; newest_first?: boolean; limit?: number }): Promise<StandardUsageRecord[]> {
    const conditions = ["org_id = $1"];
    const values: unknown[] = [input.org_id];
    if (input.standard_id) { values.push(input.standard_id); conditions.push(`standard_id = $${values.length}`); }
    if (input.version_id) { values.push(input.version_id); conditions.push(`version_id = $${values.length}`); }
    if (input.source_kind) { values.push(input.source_kind); conditions.push(`source_kind = $${values.length}`); }
    values.push(input.limit ?? 100);
    const order = input.newest_first ? "cited_at DESC, id DESC" : "cited_at, id";
    const rows = await db.query<Omit<StandardUsageRecord, "schema_version">>(`SELECT id, org_id, standard_id, version_id, source_kind, source_id, context_snapshot_id, cited_at FROM standard_usage WHERE ${conditions.join(" AND ")} ORDER BY ${order} LIMIT $${values.length}`, values);
    return rows.map((row) => validateStandardUsage({
      schema_version: STANDARD_USAGE_SCHEMA_VERSION,
      ...row,
      cited_at: toIso(row.cited_at),
    }));
  }

export async function countStandardUsage(db: PgSql, input: { org_id: string; standard_id?: string; version_id?: string; source_kind?: StandardUsageSourceKind }): Promise<number> {
    const conditions = ["org_id = $1"];
    const values: unknown[] = [input.org_id];
    if (input.standard_id) { values.push(input.standard_id); conditions.push(`standard_id = $${values.length}`); }
    if (input.version_id) { values.push(input.version_id); conditions.push(`version_id = $${values.length}`); }
    if (input.source_kind) { values.push(input.source_kind); conditions.push(`source_kind = $${values.length}`); }
    const row = await db.queryOne<{ count: string }>(`SELECT COUNT(*) AS count FROM standard_usage WHERE ${conditions.join(" AND ")}`, values);
    return Number(row?.count ?? 0);
  }

export async function listSyncWorkGaps(db: PgSql, installationId: string, options?: ListSyncWorkGapsOptions): Promise<SyncWorkGap[]> {
    const rows = await db.query<
      SyncWorkGap & { idle_until: string | null; thread_id: string | null }
    >(
      `
        WITH gaps AS (
        SELECT s.stream_key, s.phase, s.media_pending, s.idle_until, s.generation,
               'live' AS missing_lane
        FROM connector_sync_state s
        WHERE s.installation_id = $1
          AND s.phase <> 'history'
          AND NOT EXISTS (
            SELECT 1 FROM connector_sync_work w
            WHERE w.installation_id = s.installation_id
              AND w.stream_key = s.stream_key
              AND w.generation = s.generation
              AND w.lane IN ('live', 'interactive')
              AND (
                w.status IN ('pending', 'running')
                OR w.run_id IS NOT NULL
              )
          )
        UNION ALL
        SELECT s.stream_key, s.phase, s.media_pending, s.idle_until, s.generation,
               'history' AS missing_lane
        FROM connector_sync_state s
        WHERE s.installation_id = $1
          AND s.phase = 'history'
          AND NOT EXISTS (
            SELECT 1 FROM connector_sync_work w
            WHERE w.installation_id = s.installation_id
              AND w.stream_key = s.stream_key
              AND w.generation = s.generation
              AND w.lane = 'history'
              AND (
                w.status IN ('pending', 'running')
                OR w.run_id IS NOT NULL
              )
          )
        UNION ALL
        SELECT s.stream_key, s.phase, s.media_pending, s.idle_until, s.generation,
               'media' AS missing_lane
        FROM connector_sync_state s
        WHERE s.installation_id = $1
          AND s.media_pending
          AND NOT EXISTS (
            SELECT 1 FROM connector_sync_work w
            WHERE w.installation_id = s.installation_id
              AND w.stream_key = s.stream_key
              AND w.generation = s.generation
              AND w.lane = 'media'
              AND (
                w.status IN ('pending', 'running')
                OR w.run_id IS NOT NULL
              )
          )
        )
        SELECT g.stream_key, g.phase, g.media_pending, g.idle_until, g.generation,
               g.missing_lane, m.thread_id
        FROM gaps g
        LEFT JOIN connector_stream_members m
          ON m.installation_id = $1 AND m.stream_key = g.stream_key
      `,
      [installationId],
    );
    const gaps = rows.map((row) => toSyncWorkGap(db, row));
    return gaps.concat(await listUnseededSyncWorkGaps(db, installationId, options));
  }

async function listUnseededSyncWorkGaps(db: PgSql, installationId: string, options?: ListSyncWorkGapsOptions): Promise<SyncWorkGap[]> {
    const limit = Math.max(0, Math.floor(options?.unseeded_limit ?? 0));
    if (limit === 0) {
      return [];
    }
    const rows = await db.query<{
      stream_key: string;
      generation: number;
      thread_id: string | null;
    }>(
      `
        SELECT m.stream_key, m.generation, m.thread_id
        FROM connector_stream_members m
        WHERE m.installation_id = $1
          AND m.stream_key <> $2
          AND NOT EXISTS (
            SELECT 1 FROM connector_sync_state s
            WHERE s.installation_id = m.installation_id
              AND s.stream_key = m.stream_key
          )
          AND NOT EXISTS (
            SELECT 1 FROM connector_sync_work w
            WHERE w.installation_id = m.installation_id
              AND w.stream_key = m.stream_key
              AND w.generation = m.generation
              AND w.lane IN ('live', 'interactive')
              AND (
                w.status IN ('pending', 'running')
                OR w.run_id IS NOT NULL
              )
          )
        ORDER BY m.last_seen_at DESC, m.discovered_at DESC, m.stream_key ASC
        LIMIT $3
      `,
      [installationId, SYNC_CATALOG_STREAM, limit],
    );
    return rows.map((row) => ({
      stream_key: row.stream_key,
      phase: "unseeded",
      media_pending: false,
      generation: Number(row.generation),
      missing_lane: "live",
      ...(row.thread_id ? { thread_id: row.thread_id } : {}),
    }));
  }

function toSyncWorkGap(db: PgSql, row: SyncWorkGap & { idle_until: string | null; thread_id: string | null }): SyncWorkGap {
    return {
      stream_key: row.stream_key,
      phase: row.phase,
      media_pending: Boolean(row.media_pending),
      idle_until: row.idle_until ?? undefined,
      generation: Number(row.generation),
      missing_lane: row.missing_lane,
      ...(row.thread_id ? { thread_id: row.thread_id } : {}),
    };
  }

export interface StandardRow {
  payload_json: unknown;
  current_version_id: string | null;
  citation_count: number;
}

export interface StandardVersionRow {
  status: StandardVersionRecord["status"];
  payload_json: unknown;
  state_json: unknown;
}

export interface StandardGapRow {
  status: StandardGapStatus;
  payload_json: unknown;
  converted_proposal_id: string | null;
  updated_at: unknown;
}

export function toStandardGap(row: StandardGapRow): StandardGapRecord {
  return validateStandardGap({
    ...parseContextJson<StandardGapRecord>(row.payload_json),
    status: row.status,
    updated_at: toIso(row.updated_at),
    ...(row.converted_proposal_id ? { converted_proposal_id: row.converted_proposal_id } : {}),
  });
}

export function toStandard(row: StandardRow): StandardRecord {
  return validateStandard({
    ...parseContextJson<StandardRecord>(row.payload_json),
    ...(row.current_version_id ? { current_version_id: row.current_version_id } : {}),
    citation_count: Number(row.citation_count),
  });
}

export function standardVersionState(version: StandardVersionRecord): StandardVersionState {
  return {
    status: version.status,
    ...(version.gate?.upgrade_evidence ? { upgrade_evidence: version.gate.upgrade_evidence } : {}),
    ...(version.published_at ? { published_at: version.published_at } : {}),
    ...(version.published_by ? { published_by: version.published_by } : {}),
    ...(version.deprecated_at ? { deprecated_at: version.deprecated_at } : {}),
    ...(version.deprecated_by ? { deprecated_by: version.deprecated_by } : {}),
    ...(version.deprecation_evidence ? { deprecation_evidence: version.deprecation_evidence } : {}),
    ...(version.superseded_by_version_id ? { superseded_by_version_id: version.superseded_by_version_id } : {}),
  };
}

export function toStandardVersion(row: StandardVersionRow): StandardVersionRecord {
  const version = parseContextJson<StandardVersionRecord>(row.payload_json);
  const state = parseContextJson<StandardVersionState>(row.state_json);
  return validateStandardVersion({
    ...version,
    status: row.status,
    ...(version.gate && state.upgrade_evidence
      ? { gate: { ...version.gate, upgrade_evidence: state.upgrade_evidence } }
      : {}),
    ...(state.published_at ? { published_at: state.published_at } : {}),
    ...(state.published_by ? { published_by: state.published_by } : {}),
    ...(state.deprecated_at ? { deprecated_at: state.deprecated_at } : {}),
    ...(state.deprecated_by ? { deprecated_by: state.deprecated_by } : {}),
    ...(state.deprecation_evidence ? { deprecation_evidence: state.deprecation_evidence } : {}),
    ...(state.superseded_by_version_id ? { superseded_by_version_id: state.superseded_by_version_id } : {}),
  });
}
