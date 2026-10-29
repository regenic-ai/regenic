import Database from "better-sqlite3";
import type {
  ContextArtifact,
  ContextArtifactQuery,
  ContextArtifactState,
  ContextArtifactDecision,
  ContextArtifactSupersession,
  ContextArtifactProposedSupersession,
  ContextSnapshot,
  ContextSnapshotIndexEntry,
  ContextSnapshotIndexQuery,
  ContextBundle,
  ContextBundleLookup,
  ContextProjectionCheckpoint,
  ContextArtifactIndex,
  SyncCatalogSnapshot,
} from "@regenic/domain";
import {
  validateContextArtifact,
  canonicalContextJson,
  contextArtifactPreview,
  contextArtifactPreviewFromStored,
  validateContextArtifactQuery,
  validateContextSnapshot,
  validateContextSnapshotIndexEntry,
  validateContextSnapshotIndexQuery,
  validateContextBundle,
  validateContextProjectionCheckpoint,
} from "@regenic/domain";
import {
  CatalogCursorRow,
} from "./sync";
import { contextArtifactDecoder, packContextArtifact } from "../context-artifact-segments";

function artifactDecoder(db: Database.Database, orgId: string) {
  const lookup = db.prepare(
    `SELECT payload_json FROM context_artifact_segments WHERE org_id = ? AND content_hash = ?`,
  );
  return contextArtifactDecoder(orgId, (hash) => {
    const row = lookup.get(orgId, hash) as { payload_json: string } | undefined;
    return row?.payload_json;
  });
}

export async function putArtifact(db: Database.Database, artifact: ContextArtifact): Promise<ContextArtifact> {
    requireContextValue(validateContextArtifact(artifact), "artifact");
    
    const { payload, segments } = packContextArtifact(artifact);
    db.transaction(() => {
    const insertSegment = db.prepare(
      `INSERT INTO context_artifact_segments (org_id, content_hash, payload_json)
       VALUES (?, ?, ?) ON CONFLICT (org_id, content_hash) DO NOTHING`,
    );
    for (const [hash, value] of segments) insertSegment.run(artifact.org_id, hash, value);
    putImmutableContextJson(db, 
      "context_artifacts",
      "org_id = ? AND id = ?",
      [artifact.org_id, artifact.id],
      payload,
      "artifact",
      `
        INSERT INTO context_artifacts (
          org_id, id, kind, status, generation, recorded_at, payload_json, preview_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        artifact.org_id,
        artifact.id,
        artifact.kind,
        artifact.status,
        artifact.generation,
        artifact.recorded_at,
        payload,
        canonicalContextJson(contextArtifactPreview(artifact)),
      ],
    );
    db.prepare(
      `INSERT OR IGNORE INTO context_artifact_states (org_id, artifact_id, status, decided_at) VALUES (?, ?, ?, ?)`,
    ).run(artifact.org_id, artifact.id, artifact.status, artifact.recorded_at);
    })();
    return parseContextJson<ContextArtifact>(canonicalContextJson(artifact));
  }

export async function getArtifact(db: Database.Database, orgId: string, id: string): Promise<ContextArtifact | null> {
    const stored = getContextJson<unknown>(db,
      "context_artifacts",
      "org_id = ? AND id = ?",
      [orgId, id],
    );
    if (!stored) return null;
    const artifact = artifactDecoder(db, orgId)(stored);
    const state = await getArtifactState(db, orgId, id);
    return state ? { ...artifact, status: state.status } : artifact;
  }

export async function listArtifacts(db: Database.Database, query: ContextArtifactQuery): Promise<ContextArtifact[]> {
    const parts = artifactListParts(query);
    if (!parts) {
      return [];
    }
    const rows = db
      .prepare(
        `
          SELECT a.id, a.recorded_at, a.payload_json, s.status AS lifecycle_status FROM context_artifacts a
          JOIN context_artifact_states s ON s.org_id = a.org_id AND s.artifact_id = a.id
          WHERE ${parts.clauses.join(" AND ")}
        `,
      )
      .all(...parts.params) as Array<{
        id: string; recorded_at: string; payload_json: string; lifecycle_status: ContextArtifact["status"];
      }>;
    const decode = artifactDecoder(db, query.org_id);
    return rows
      .sort(compareContextArtifactOrder)
      .slice(0, parts.limit)
      .map((row) => ({ ...decode(row.payload_json), status: row.lifecycle_status }));
  }

export async function listArtifactIndexes(db: Database.Database, query: ContextArtifactQuery): Promise<ContextArtifactIndex[]> {
    const parts = artifactListParts(query);
    if (!parts) {
      return [];
    }
    const rows = db
      .prepare(
        `
          SELECT a.id, a.kind, a.recorded_at, a.preview_json, s.status AS lifecycle_status
          FROM context_artifacts a
          JOIN context_artifact_states s ON s.org_id = a.org_id AND s.artifact_id = a.id
          WHERE ${parts.clauses.join(" AND ")}
        `,
      )
      .all(...parts.params) as Array<{
        id: string;
        kind: string;
        recorded_at: string;
        preview_json: string;
        lifecycle_status: string;
      }>;
    return rows
      .sort((left, right) => compareRecordedId(left.recorded_at, left.id, right.recorded_at, right.id))
      .slice(0, parts.limit)
      .map((row) => ({
        id: row.id,
        kind: row.kind,
        status: row.lifecycle_status,
        recorded_at: row.recorded_at,
        preview: contextArtifactPreviewFromStored(row.preview_json),
      }));
  }

export function rebuildArtifactPreviews(db: Database.Database): void {
  const rows = db.prepare(
    `SELECT org_id, id, payload_json FROM context_artifacts`,
  ).all() as Array<{ org_id: string; id: string; payload_json: string }>;
  const update = db.prepare(
    `UPDATE context_artifacts SET preview_json = ? WHERE org_id = ? AND id = ?`,
  );
  for (const row of rows) {
    update.run(previewJson(row.payload_json, (payload) => artifactDecoder(db, row.org_id)(payload)), row.org_id, row.id);
  }
}

function previewJson(payload: string, decode: (payload: unknown) => ContextArtifact): string {
  let parsed: unknown = {};
  try {
    parsed = JSON.parse(payload) as unknown;
  } catch {
    parsed = {};
  }
  if (parsed && typeof parsed === "object" && "_shared" in parsed) parsed = decode(parsed);
  return canonicalContextJson(contextArtifactPreview(parsed as ContextArtifact));
}

function artifactListParts(query: ContextArtifactQuery): {
  clauses: string[];
  params: unknown[];
  limit: number;
} | null {
  const validation = validateContextArtifactQuery(query);
  requireContextValue(validation, "artifact query");
  const stableQuery = validation.success ? validation.data : query;
  const clauses = ["a.org_id = ?"];
  const params: unknown[] = [stableQuery.org_id];
  if (stableQuery.kinds) {
    if (stableQuery.kinds.length === 0) {
      return null;
    }
    clauses.push(`a.kind IN (${stableQuery.kinds.map(() => "?").join(", ")})`);
    params.push(...stableQuery.kinds);
  }
  if (stableQuery.statuses) {
    if (stableQuery.statuses.length === 0) {
      return null;
    }
    clauses.push(`s.status IN (${stableQuery.statuses.map(() => "?").join(", ")})`);
    params.push(...stableQuery.statuses);
  }
  if (stableQuery.generation) {
    clauses.push("a.generation = ?");
    params.push(stableQuery.generation);
  }
  return {
    clauses,
    params,
    limit: stableQuery.limit ?? Number.POSITIVE_INFINITY,
  };
}

export async function getArtifactState(db: Database.Database, orgId: string, artifactId: string): Promise<ContextArtifactState | null> {
    const row = db.prepare(
      `SELECT org_id, artifact_id, status, decided_at, superseded_by FROM context_artifact_states WHERE org_id = ? AND artifact_id = ?`,
    ).get(orgId, artifactId) as ArtifactStateRow | undefined;
    return row ? artifactState(row) : null;
  }

export async function decideArtifact(db: Database.Database, input: ContextArtifactDecision): Promise<ContextArtifactState> {
    assertArtifactDecision(input);
    
    return db.transaction(() => {
      const state = artifactStateForTransition(db, input.org_id, input.artifact_id);
      db.prepare(
        `UPDATE context_artifact_states SET status = ?, decided_at = ?, superseded_by = NULL WHERE org_id = ? AND artifact_id = ?`,
      ).run(input.status, input.decided_at, input.org_id, input.artifact_id);
      return { ...state, status: input.status, decided_at: input.decided_at } as ContextArtifactState;
    })();
  }

export async function supersedeArtifact(db: Database.Database, input: ContextArtifactSupersession): Promise<{ superseded: ContextArtifactState; accepted: ContextArtifactState }> {
    assertArtifactSupersession(input);
    
    return db.transaction(() => {
      const current = getArtifactStateSync(db, input.org_id, input.artifact_id);
      const replacement = artifactStateForTransition(db, input.org_id, input.replacement_id);
      const artifact = getContextJson<Pick<ContextArtifact, "supersedes_id">>(db, "context_artifacts", "org_id = ? AND id = ?", [input.org_id, input.replacement_id]);
      if (!current || current.status !== "accepted" || !artifact || artifact.supersedes_id !== input.artifact_id) {
        throw new Error("Invalid Context artifact supersession");
      }
      db.prepare(`UPDATE context_artifact_states SET status = 'superseded', decided_at = ?, superseded_by = ? WHERE org_id = ? AND artifact_id = ?`).run(input.decided_at, input.replacement_id, input.org_id, input.artifact_id);
      db.prepare(`UPDATE context_artifact_states SET status = 'accepted', decided_at = ?, superseded_by = NULL WHERE org_id = ? AND artifact_id = ?`).run(input.decided_at, input.org_id, input.replacement_id);
      return {
        superseded: { ...current, status: "superseded" as const, decided_at: input.decided_at, superseded_by: input.replacement_id },
        accepted: { ...replacement, status: "accepted" as const, decided_at: input.decided_at },
      };
    })();
  }

export async function supersedeProposedArtifact(db: Database.Database, input: ContextArtifactProposedSupersession): Promise<{ superseded: ContextArtifactState; replacement: ContextArtifactState }> {
    
    return db.transaction(() => {
      const current = getArtifactStateSync(db, input.org_id, input.artifact_id);
      const replacement = artifactStateForTransition(db, input.org_id, input.replacement_id);
      const currentArtifact = getContextJson<Pick<ContextArtifact, "kind">>(db, "context_artifacts", "org_id = ? AND id = ?", [input.org_id, input.artifact_id]);
      const replacementArtifact = getContextJson<Pick<ContextArtifact, "kind" | "supersedes_id">>(db, "context_artifacts", "org_id = ? AND id = ?", [input.org_id, input.replacement_id]);
      if (!current || current.status !== "proposed" || !currentArtifact || !replacementArtifact || currentArtifact.kind !== "daily_digest" || replacementArtifact.kind !== "daily_digest" || replacementArtifact.supersedes_id !== input.artifact_id) {
        throw new Error("Invalid proposed daily digest supersession");
      }
      db.prepare(`UPDATE context_artifact_states SET status = 'superseded', decided_at = ?, superseded_by = ? WHERE org_id = ? AND artifact_id = ?`).run(input.decided_at, input.replacement_id, input.org_id, input.artifact_id);
      db.prepare(`UPDATE context_artifact_states SET status = 'proposed', decided_at = ?, superseded_by = NULL WHERE org_id = ? AND artifact_id = ?`).run(input.decided_at, input.org_id, input.replacement_id);
      return {
        superseded: { ...current, status: "superseded" as const, decided_at: input.decided_at, superseded_by: input.replacement_id },
        replacement: { ...replacement, status: "proposed" as const, decided_at: input.decided_at },
      };
    })();
  }

function getArtifactStateSync(db: Database.Database, orgId: string, artifactId: string): ContextArtifactState | null {
    const row = db.prepare(`SELECT org_id, artifact_id, status, decided_at, superseded_by FROM context_artifact_states WHERE org_id = ? AND artifact_id = ?`).get(orgId, artifactId) as ArtifactStateRow | undefined;
    return row ? artifactState(row) : null;
  }

function artifactStateForTransition(db: Database.Database, orgId: string, artifactId: string): ContextArtifactState {
    const state = getArtifactStateSync(db, orgId, artifactId);
    if (!state || !["proposed", "needs_clarify"].includes(state.status)) throw new Error("Context artifact is not transitionable");
    return state;
  }

export async function putSnapshot(db: Database.Database, snapshot: ContextSnapshot): Promise<void> {
    requireContextValue(validateContextSnapshot(snapshot), "snapshot");
    
    const payload = canonicalContextJson(snapshot);
    putImmutableContextJson(db, 
      "context_snapshots",
      "org_id = ? AND id = ?",
      [snapshot.org_id, snapshot.id],
      payload,
      "snapshot",
      "INSERT INTO context_snapshots (org_id, id, payload_json) VALUES (?, ?, ?)",
      [snapshot.org_id, snapshot.id, payload],
    );
  }

export async function getSnapshot(db: Database.Database, orgId: string, id: string): Promise<ContextSnapshot | null> {
    return getContextJson<ContextSnapshot>(db, 
      "context_snapshots",
      "org_id = ? AND id = ?",
      [orgId, id],
    );
  }

export async function putSnapshotIndex(db: Database.Database, entry: ContextSnapshotIndexEntry): Promise<void> {
    requireContextValue(validateContextSnapshotIndexEntry(entry), "snapshot index entry");
    const payload = canonicalContextJson(entry);
    const lookup = [
      entry.org_id,
      entry.thread_id,
      entry.snapshot_id,
      entry.principal.actor_type,
      entry.principal.actor_id,
      entry.consumer_id,
    ];
    putImmutableContextJson(
      db,
      "context_snapshot_index",
      `
        org_id = ? AND thread_id = ? AND snapshot_id = ?
        AND principal_actor_type = ? AND principal_actor_id = ? AND consumer_id = ?
      `,
      lookup,
      payload,
      "snapshot index entry",
      `
        INSERT INTO context_snapshot_index (
          org_id, thread_id, snapshot_id, principal_actor_type,
          principal_actor_id, consumer_id, created_at, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [...lookup, entry.created_at, payload],
    );
  }

export async function listSnapshotIndex(db: Database.Database, query: ContextSnapshotIndexQuery): Promise<ContextSnapshotIndexEntry[]> {
    const validation = validateContextSnapshotIndexQuery(query);
    requireContextValue(validation, "snapshot index query");
    const stableQuery = validation.success ? validation.data : query;
    const purpose = stableQuery.purpose
      ? "AND json_extract(payload_json, '$.purpose') = ?"
      : "";
    const cursor = stableQuery.before_created_at
      ? `
        AND (
          created_at < ? OR (created_at = ? AND snapshot_id < ?)
        )
      `
      : "";
    const rows = db.prepare(`
      SELECT payload_json
      FROM context_snapshot_index
      WHERE org_id = ? AND thread_id = ?
        AND principal_actor_type = ? AND principal_actor_id = ? AND consumer_id = ?
        ${purpose}
        ${cursor}
      ORDER BY created_at DESC, snapshot_id DESC
      LIMIT ?
    `).all(
      stableQuery.org_id,
      stableQuery.thread_id,
      stableQuery.principal.actor_type,
      stableQuery.principal.actor_id,
      stableQuery.consumer_id,
      ...(stableQuery.purpose ? [stableQuery.purpose] : []),
      ...(stableQuery.before_created_at
        ? [
          stableQuery.before_created_at,
          stableQuery.before_created_at,
          stableQuery.before_snapshot_id!,
        ]
        : []),
      stableQuery.limit ?? 100,
    ) as Array<{ payload_json: string }>;
    return rows.map((row) => parseContextJson<ContextSnapshotIndexEntry>(row.payload_json));
  }

export async function putBundle(db: Database.Database, bundle: ContextBundle): Promise<void> {
    requireContextValue(validateContextBundle(bundle), "bundle");
    
    const payload = canonicalContextJson(bundle);
    const lookup = [
      bundle.org_id,
      bundle.snapshot_id,
      bundle.principal.actor_type,
      bundle.principal.actor_id,
      bundle.consumer_id,
    ];
    putImmutableContextJson(db, 
      "context_bundles",
      `
        org_id = ? AND snapshot_id = ? AND principal_actor_type = ?
        AND principal_actor_id = ? AND consumer_id = ?
      `,
      lookup,
      payload,
      "bundle",
      `
        INSERT INTO context_bundles (
          org_id, snapshot_id, principal_actor_type, principal_actor_id,
          consumer_id, payload_json
        ) VALUES (?, ?, ?, ?, ?, ?)
      `,
      [...lookup, payload],
    );
  }

export async function getBundle(db: Database.Database, query: ContextBundleLookup): Promise<ContextBundle | null> {
    return getContextJson<ContextBundle>(db, 
      "context_bundles",
      `
        org_id = ? AND snapshot_id = ? AND principal_actor_type = ?
        AND principal_actor_id = ? AND consumer_id = ?
      `,
      [
        query.org_id,
        query.snapshot_id,
        query.principal.actor_type,
        query.principal.actor_id,
        query.consumer_id,
      ],
    );
  }

export async function putCheckpoint(db: Database.Database, checkpoint: ContextProjectionCheckpoint): Promise<void> {
    const validation = validateContextProjectionCheckpoint(checkpoint);
    requireContextValue(validation, "projection checkpoint");
    const stableCheckpoint = validation.success ? validation.data : checkpoint;
    
    const transaction = db.transaction(() => {
      const current = db
        .prepare(
          `
            SELECT payload_json FROM context_projection_checkpoints
            WHERE org_id = ? AND projector_id = ? AND generation = ?
          `,
        )
        .get(
          stableCheckpoint.org_id,
          stableCheckpoint.projector_id,
          stableCheckpoint.generation,
        ) as { payload_json: string } | undefined;
      if (current) {
        const stored = parseContextJson<ContextProjectionCheckpoint>(current.payload_json);
        if (stored.algorithm_version !== stableCheckpoint.algorithm_version) {
          throw new Error("Projection checkpoint algorithm cannot change within a generation");
        }
        if (stored.sequence > stableCheckpoint.sequence) {
          throw new Error("Projection checkpoint cannot move backwards");
        }
        if (stored.sequence === stableCheckpoint.sequence) {
          if (current.payload_json === canonicalContextJson(stableCheckpoint)) {
            return;
          }
          if (
            stored.watermark === stableCheckpoint.watermark ||
            Date.parse(stableCheckpoint.updated_at) <= Date.parse(stored.updated_at)
          ) {
            throw new Error("Projection checkpoint cannot regress at the same sequence");
          }
        }
      }
      const payload = canonicalContextJson(stableCheckpoint);
      db
        .prepare(
          `
            INSERT INTO context_projection_checkpoints (
              org_id, projector_id, generation, algorithm_version,
              sequence, watermark, updated_at, payload_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(org_id, projector_id, generation) DO UPDATE SET
              algorithm_version = excluded.algorithm_version,
              sequence = excluded.sequence,
              watermark = excluded.watermark,
              updated_at = excluded.updated_at,
              payload_json = excluded.payload_json
          `,
        )
        .run(
          stableCheckpoint.org_id,
          stableCheckpoint.projector_id,
          stableCheckpoint.generation,
          stableCheckpoint.algorithm_version,
          stableCheckpoint.sequence,
          stableCheckpoint.watermark,
          stableCheckpoint.updated_at,
          payload,
        );
    });
    transaction.immediate();
  }

export async function getCheckpoint(db: Database.Database, orgId: string, projectorId: string, generation: string): Promise<ContextProjectionCheckpoint | null> {
    return getContextJson<ContextProjectionCheckpoint>(db, 
      "context_projection_checkpoints",
      "org_id = ? AND projector_id = ? AND generation = ?",
      [orgId, projectorId, generation],
    );
  }

function getContextJson<T>(db: Database.Database, table: string, where: string, params: unknown[]): T | null {
    const row = db
      .prepare(`SELECT payload_json FROM ${table} WHERE ${where}`)
      .get(...params) as { payload_json: string } | undefined;
    return row ? parseContextJson<T>(row.payload_json) : null;
  }

function putImmutableContextJson(db: Database.Database, table: string, where: string, lookupParams: unknown[], payload: string, label: string, insertSql: string, insertParams: unknown[]): void {
    const transaction = db.transaction(() => {
      const current = db
        .prepare(`SELECT payload_json FROM ${table} WHERE ${where}`)
        .get(...lookupParams) as { payload_json: string } | undefined;
      if (current) {
        if (current.payload_json !== payload) {
          throw new Error(`Cannot replace immutable context ${label}`);
        }
        return;
      }
      db.prepare(insertSql).run(...insertParams);
    });
    transaction.immediate();
  }

export function toCatalogSnapshot(db: Database.Database, row: CatalogCursorRow): SyncCatalogSnapshot {
    return {
      installation_id: row.installation_id,
      ...(row.cursor_value ? { cursor: row.cursor_value } : {}),
      complete: row.complete === 1,
      generation: row.generation,
      updated_at: row.updated_at,
    };
  }

function parseContextJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function requireContextValue(
  result: { success: true } | { success: false; issues: Array<{ message: string }> },
  label: string,
): void {
  if (!result.success) {
    throw new Error(
      `Invalid context ${label}: ${result.issues.map((issue) => issue.message).join("; ")}`,
    );
  }
}

function compareContextArtifactOrder(
  left: Pick<ContextArtifact, "id" | "recorded_at">,
  right: Pick<ContextArtifact, "id" | "recorded_at">,
): number {
  return compareRecordedId(left.recorded_at, left.id, right.recorded_at, right.id);
}

function compareRecordedId(leftAt: string, leftId: string, rightAt: string, rightId: string): number {
  const leftKey = `${leftAt}\u0000${leftId}`;
  const rightKey = `${rightAt}\u0000${rightId}`;
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

interface ArtifactStateRow {
  org_id: string;
  artifact_id: string;
  status: ContextArtifactState["status"];
  decided_at: string;
  superseded_by: string | null;
}

function artifactState(row: ArtifactStateRow): ContextArtifactState {
  return {
    org_id: row.org_id,
    artifact_id: row.artifact_id,
    status: row.status,
    decided_at: row.decided_at,
    ...(row.superseded_by ? { superseded_by: row.superseded_by } : {}),
  };
}

function assertArtifactDecision(input: ContextArtifactDecision): void {
  if (!input?.org_id?.trim() || !input.artifact_id?.trim() || !["accepted", "rejected", "needs_clarify"].includes(input.status) || Number.isNaN(Date.parse(input.decided_at))) throw new Error("Invalid Context artifact decision");
}

function assertArtifactSupersession(input: ContextArtifactSupersession): void {
  if (!input?.org_id?.trim() || !input.artifact_id?.trim() || !input.replacement_id?.trim() || input.artifact_id === input.replacement_id || Number.isNaN(Date.parse(input.decided_at))) throw new Error("Invalid Context artifact supersession");
}
