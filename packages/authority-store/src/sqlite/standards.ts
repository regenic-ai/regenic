import Database from "better-sqlite3";
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
  SyncPhase,
  StandardVersionState,
} from "@regenic/domain";
import {
  transitionStandardVersion as applyStandardVersionTransition,
  canonicalContextJson,
  validateStandardGap,
  validateDecision,
  validateStandardUsage,
  STANDARD_USAGE_SCHEMA_VERSION,
  hashCanonicalContext,
  SYNC_CATALOG_STREAM,
  validateStandard,
  validateStandardVersion,
} from "@regenic/domain";
import {
  getAgentRunRow,
  toAgentRun,
} from "./agent-runs";

export async function getStandard(db: Database.Database, orgId: string, standardId: string): Promise<StandardRecord | null> {
    return getStandardSync(db, orgId, standardId);
  }

export async function getStandardBySlug(db: Database.Database, orgId: string, slug: string): Promise<StandardRecord | null> {
    const row = db.prepare(`SELECT payload_json, current_version_id, citation_count FROM standards WHERE org_id = ? AND slug = ?`).get(orgId, slug) as StandardRow | undefined;
    return row ? toStandard(row) : null;
  }

export async function listStandards(db: Database.Database, input: {
    org_id: string;
    limit?: number;
    after_created_at?: string;
    after_id?: string;
  }): Promise<StandardRecord[]> {
    const hasCursor = !!input.after_created_at && !!input.after_id;
    const rows = db.prepare(
      `SELECT payload_json, current_version_id, citation_count FROM standards
       WHERE org_id = ?${hasCursor ? " AND (created_at > ? OR (created_at = ? AND id > ?))" : ""}
       ORDER BY created_at, id LIMIT ?`,
    ).all(...(hasCursor
      ? [input.org_id, input.after_created_at!, input.after_created_at!, input.after_id!, input.limit ?? 100]
      : [input.org_id, input.limit ?? 100])) as StandardRow[];
    return rows.map(toStandard);
  }

export async function getStandardVersion(db: Database.Database, orgId: string, versionId: string): Promise<StandardVersionRecord | null> {
    return getStandardVersionSync(db, orgId, versionId);
  }

export async function listStandardVersions(db: Database.Database, input: { org_id: string; standard_id: string; limit?: number }): Promise<StandardVersionRecord[]> {
    const rows = db.prepare(`SELECT status, payload_json, state_json FROM standard_versions WHERE org_id = ? AND standard_id = ? ORDER BY created_at, id LIMIT ?`).all(input.org_id, input.standard_id, input.limit ?? 100) as StandardVersionRow[];
    return rows.map(toStandardVersion);
  }

export async function transitionStandardVersion(db: Database.Database, input: StandardVersionTransition): Promise<StandardVersionRecord | null> {
    
    return db.transaction(() => {
      const row = db.prepare(`SELECT status, payload_json, state_json FROM standard_versions WHERE org_id = ? AND id = ?`).get(input.org_id, input.version_id) as StandardVersionRow | undefined;
      if (!row) return null;
      const current = toStandardVersion(row);
      const standard = getStandardSync(db, input.org_id, current.standard_id);
      if (!standard) throw new Error("Standard was not found");
      if (input.superseded_by_version_id) {
        const replacement = getStandardVersionSync(db, input.org_id, input.superseded_by_version_id);
        if (!replacement || replacement.standard_id !== current.standard_id || replacement.status !== "active") {
          throw new Error("StandardVersion replacement must be active in the same Standard");
        }
      }
      const next = applyStandardVersionTransition(current, standard, input);
      db.prepare(`UPDATE standard_versions SET status = ?, state_json = ? WHERE org_id = ? AND id = ? AND status = ?`).run(next.status, canonicalContextJson(standardVersionState(next)), input.org_id, input.version_id, current.status);
      if (next.status === "trial" || next.status === "active") {
        db.prepare(`UPDATE standards SET current_version_id = ? WHERE org_id = ? AND id = ?`).run(next.id, input.org_id, standard.id);
      } else if (next.superseded_by_version_id) {
        db.prepare(`UPDATE standards SET current_version_id = ? WHERE org_id = ? AND id = ? AND current_version_id = ?`).run(next.superseded_by_version_id, input.org_id, standard.id, next.id);
      }
      return next;
    })();
  }

export async function putStandardGap(db: Database.Database, input: StandardGapRecord): Promise<StandardGapRecord> {
    
    const gap = validateStandardGap(input);
    if (gap.status !== "open") throw new Error("New StandardGap must be open");
    db.prepare(`INSERT INTO standard_gaps (id, org_id, source_kind, source_ref, status, payload_json, converted_proposal_id, created_at, updated_at) VALUES (?, ?, ?, ?, 'open', ?, NULL, ?, ?) ON CONFLICT DO NOTHING`).run(gap.id, gap.org_id, gap.source_kind, gap.source_ref, canonicalContextJson(gap), gap.created_at, gap.updated_at);
    const row = db.prepare(`SELECT status, payload_json, converted_proposal_id, updated_at FROM standard_gaps WHERE org_id = ? AND source_kind = ? AND source_ref = ?`).get(gap.org_id, gap.source_kind, gap.source_ref) as StandardGapRow | undefined;
    if (!row) throw new Error("Cannot persist StandardGap");
    const storedCreation = validateStandardGap(JSON.parse(row.payload_json) as StandardGapRecord);
    if (canonicalContextJson(storedCreation) !== canonicalContextJson({
      ...gap,
      id: storedCreation.id,
      created_at: storedCreation.created_at,
      updated_at: storedCreation.updated_at,
    })) throw new Error("Cannot replace immutable StandardGap");
    return toStandardGap(row);
  }

export async function getStandardGap(db: Database.Database, orgId: string, gapId: string): Promise<StandardGapRecord | null> {
    const row = db.prepare(`SELECT status, payload_json, converted_proposal_id, updated_at FROM standard_gaps WHERE org_id = ? AND id = ?`).get(orgId, gapId) as StandardGapRow | undefined;
    return row ? toStandardGap(row) : null;
  }

export async function listStandardGaps(db: Database.Database, input: { org_id: string; status?: StandardGapStatus; limit?: number }): Promise<StandardGapRecord[]> {
    const rows = db.prepare(`SELECT status, payload_json, converted_proposal_id, updated_at FROM standard_gaps WHERE org_id = ? ${input.status ? "AND status = ?" : ""} ORDER BY created_at, id LIMIT ?`).all(...(input.status ? [input.org_id, input.status, input.limit ?? 100] : [input.org_id, input.limit ?? 100])) as StandardGapRow[];
    return rows.map(toStandardGap);
  }

export async function dismissStandardGap(db: Database.Database, input: { org_id: string; gap_id: string; dismissed_at: string }): Promise<StandardGapRecord | null> {
    
    if (!input.org_id?.trim() || !input.gap_id?.trim() || Number.isNaN(Date.parse(input.dismissed_at))) throw new Error("Invalid StandardGap dismissal");
    const transaction = db.transaction(() => {
      const row = db.prepare(`SELECT status, payload_json, converted_proposal_id, updated_at FROM standard_gaps WHERE org_id = ? AND id = ?`).get(input.org_id, input.gap_id) as StandardGapRow | undefined;
      if (!row) return null;
      const gap = toStandardGap(row);
      if (gap.status === "converted") throw new Error("Converted StandardGap cannot be dismissed");
      if (gap.status === "dismissed") return gap;
      if (Date.parse(input.dismissed_at) < Date.parse(gap.created_at)) throw new Error("Invalid StandardGap dismissal");
      const changed = db.prepare(`UPDATE standard_gaps SET status = 'dismissed', updated_at = ? WHERE org_id = ? AND id = ? AND status = 'open'`).run(input.dismissed_at, input.org_id, input.gap_id).changes;
      if (changed !== 1) throw new Error("StandardGap state changed during dismissal");
      return validateStandardGap({ ...gap, status: "dismissed", updated_at: input.dismissed_at });
    });
    return transaction.immediate();
  }

export async function projectStandardUsage(db: Database.Database, input: { org_id: string; source_kind: StandardUsageSourceKind; source_id: string }): Promise<StandardUsageRecord[]> {
    
    const transaction = db.transaction(() => {
      if (!input.org_id?.trim() || !input.source_id?.trim() || !["decision", "agent_run"].includes(input.source_kind)) {
        throw new Error("Invalid StandardUsage projection");
      }
      let bindings: Array<{ standard_id: string; version_id: string }>;
      let contextSnapshotId: string;
      let citedAt: string;
      if (input.source_kind === "decision") {
        const row = db.prepare(`SELECT payload_json FROM decisions WHERE org_id = ? AND id = ?`).get(input.org_id, input.source_id) as { payload_json: string } | undefined;
        if (!row) throw new Error("StandardUsage source Decision was not found");
        const decision = validateDecision(JSON.parse(row.payload_json) as DecisionRecord);
        bindings = decision.standard_bindings;
        contextSnapshotId = decision.context_snapshot_id;
        citedAt = decision.committed_at;
      } else {
        const row = getAgentRunRow(db, input.org_id, input.source_id);
        if (!row) throw new Error("StandardUsage source AgentRun was not found");
        const run = toAgentRun(row);
        bindings = run.standard_bindings;
        contextSnapshotId = run.context_snapshot_id;
        citedAt = run.created_at;
      }
      const usages = bindings.map((binding) => {
        const standard = getStandardSync(db, input.org_id, binding.standard_id);
        const version = getStandardVersionSync(db, input.org_id, binding.version_id);
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
        db.prepare(`INSERT INTO standard_usage (id, org_id, standard_id, version_id, source_kind, source_id, context_snapshot_id, cited_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`).run(usage.id, usage.org_id, usage.standard_id, usage.version_id, usage.source_kind, usage.source_id, usage.context_snapshot_id, usage.cited_at);
        return usage;
      });
      for (const standardId of new Set(usages.map(({ standard_id }) => standard_id))) {
        db.prepare(`UPDATE standards SET citation_count = (SELECT COUNT(*) FROM standard_usage WHERE org_id = ? AND standard_id = ?) WHERE org_id = ? AND id = ?`).run(input.org_id, standardId, input.org_id, standardId);
      }
      return usages;
    });
    return transaction.immediate();
  }

export async function listStandardUsage(db: Database.Database, input: { org_id: string; standard_id?: string; version_id?: string; source_kind?: StandardUsageSourceKind; newest_first?: boolean; limit?: number }): Promise<StandardUsageRecord[]> {
    const conditions = ["org_id = ?"];
    const values: Array<string | number> = [input.org_id];
    if (input.standard_id) { conditions.push("standard_id = ?"); values.push(input.standard_id); }
    if (input.version_id) { conditions.push("version_id = ?"); values.push(input.version_id); }
    if (input.source_kind) { conditions.push("source_kind = ?"); values.push(input.source_kind); }
    values.push(input.limit ?? 100);
    const order = input.newest_first
      ? "julianday(cited_at) DESC, id DESC"
      : "julianday(cited_at), id";
    const rows = db.prepare(`SELECT id, org_id, standard_id, version_id, source_kind, source_id, context_snapshot_id, cited_at FROM standard_usage WHERE ${conditions.join(" AND ")} ORDER BY ${order} LIMIT ?`).all(...values) as Array<Omit<StandardUsageRecord, "schema_version">>;
    return rows.map((row) => validateStandardUsage({
      schema_version: STANDARD_USAGE_SCHEMA_VERSION,
      ...row,
    }));
  }

export async function countStandardUsage(db: Database.Database, input: { org_id: string; standard_id?: string; version_id?: string; source_kind?: StandardUsageSourceKind }): Promise<number> {
    const conditions = ["org_id = ?"];
    const values: string[] = [input.org_id];
    if (input.standard_id) { conditions.push("standard_id = ?"); values.push(input.standard_id); }
    if (input.version_id) { conditions.push("version_id = ?"); values.push(input.version_id); }
    if (input.source_kind) { conditions.push("source_kind = ?"); values.push(input.source_kind); }
    const row = db.prepare(`SELECT COUNT(*) AS count FROM standard_usage WHERE ${conditions.join(" AND ")}`).get(...values) as { count: number };
    return row.count;
  }

export function getStandardSync(db: Database.Database, orgId: string, standardId: string): StandardRecord | null {
    const row = db.prepare(`SELECT payload_json, current_version_id, citation_count FROM standards WHERE org_id = ? AND id = ?`).get(orgId, standardId) as StandardRow | undefined;
    return row ? toStandard(row) : null;
  }

export function getStandardVersionSync(db: Database.Database, orgId: string, versionId: string): StandardVersionRecord | null {
    const row = db.prepare(`SELECT status, payload_json, state_json FROM standard_versions WHERE org_id = ? AND id = ?`).get(orgId, versionId) as StandardVersionRow | undefined;
    return row ? toStandardVersion(row) : null;
  }

export async function listSyncWorkGaps(db: Database.Database, installationId: string, options?: ListSyncWorkGapsOptions): Promise<SyncWorkGap[]> {
    const rows = db
      .prepare(
        `
          WITH gaps AS (
          SELECT s.stream_key, s.phase, s.media_pending, s.idle_until, s.generation,
                 'live' AS missing_lane
          FROM connector_sync_state s
          WHERE s.installation_id = ?
            AND s.phase != 'history'
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
          WHERE s.installation_id = ?
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
          WHERE s.installation_id = ?
            AND s.media_pending != 0
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
            ON m.installation_id = ? AND m.stream_key = g.stream_key
        `,
      )
      .all(installationId, installationId, installationId, installationId) as Array<{
      stream_key: string;
      phase: SyncPhase;
      media_pending: number;
      idle_until: string | null;
      generation: number;
      missing_lane: SyncWorkGap["missing_lane"];
      thread_id: string | null;
    }>;
    return rows
      .map((row) => toSyncWorkGap(db, row))
      .concat(listUnseededSyncWorkGaps(db, installationId, options));
  }

function listUnseededSyncWorkGaps(db: Database.Database, installationId: string, options?: ListSyncWorkGapsOptions): SyncWorkGap[] {
    const limit = Math.max(0, Math.floor(options?.unseeded_limit ?? 0));
    if (limit === 0) {
      return [];
    }
    const rows = db
      .prepare(
        `
          SELECT m.stream_key, m.generation, m.thread_id
          FROM connector_stream_members m
          WHERE m.installation_id = ?
            AND m.stream_key != ?
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
          LIMIT ?
        `,
      )
      .all(installationId, SYNC_CATALOG_STREAM, limit) as Array<{
      stream_key: string;
      generation: number;
      thread_id: string | null;
    }>;
    return rows.map((row) => ({
      stream_key: row.stream_key,
      phase: "unseeded" as const,
      media_pending: false,
      generation: row.generation,
      missing_lane: "live" as const,
      ...(row.thread_id ? { thread_id: row.thread_id } : {}),
    }));
  }

function toSyncWorkGap(db: Database.Database, row: {
    stream_key: string;
    phase: SyncPhase;
    media_pending: number;
    idle_until: string | null;
    generation: number;
    missing_lane: SyncWorkGap["missing_lane"];
    thread_id: string | null;
  }): SyncWorkGap {
    return {
      stream_key: row.stream_key,
      phase: row.phase,
      media_pending: row.media_pending !== 0,
      idle_until: row.idle_until ?? undefined,
      generation: row.generation,
      missing_lane: row.missing_lane,
      ...(row.thread_id ? { thread_id: row.thread_id } : {}),
    };
  }

export interface StandardRow {
  payload_json: string;
  current_version_id: string | null;
  citation_count: number;
}

export interface StandardVersionRow {
  status: StandardVersionRecord["status"];
  payload_json: string;
  state_json: string;
}

export interface StandardGapRow {
  status: StandardGapStatus;
  payload_json: string;
  converted_proposal_id: string | null;
  updated_at: string;
}

export function toStandardGap(row: StandardGapRow): StandardGapRecord {
  return validateStandardGap({
    ...(JSON.parse(row.payload_json) as StandardGapRecord),
    status: row.status,
    updated_at: row.updated_at,
    ...(row.converted_proposal_id ? { converted_proposal_id: row.converted_proposal_id } : {}),
  });
}

export function toStandard(row: StandardRow): StandardRecord {
  return validateStandard({
    ...(JSON.parse(row.payload_json) as StandardRecord),
    ...(row.current_version_id ? { current_version_id: row.current_version_id } : {}),
    citation_count: row.citation_count,
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
  const version = JSON.parse(row.payload_json) as StandardVersionRecord;
  const state = JSON.parse(row.state_json) as StandardVersionState;
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
