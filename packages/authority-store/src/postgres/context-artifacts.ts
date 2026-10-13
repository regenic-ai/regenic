import type {
  ContextArtifactState,
  ContextArtifact,
  ContextArtifactQuery,
  ContextArtifactDecision,
  ContextArtifactSupersession,
  ContextArtifactProposedSupersession,
  ContextSnapshot,
  ContextBundle,
  ContextBundleLookup,
  ContextProjectionCheckpoint,
  SyncCatalogSnapshot,
} from "@regenic/domain";
import {
  validateContextArtifact,
  canonicalContextJson,
  validateContextArtifactQuery,
  validateContextSnapshot,
  validateContextBundle,
  validateContextProjectionCheckpoint,
} from "@regenic/domain";
import type {
  PoolClient,
} from "pg";
import {
  PgSql,
  asBool,
  asJson,
  asNumber,
  toIso,
} from "./sql";
import {
  CatalogCursorRow,
} from "./sync";

interface ArtifactStateRow {
  org_id: string;
  artifact_id: string;
  status: ContextArtifactState["status"];
  decided_at: string;
  superseded_by: string | null;
}

export async function putArtifact(db: PgSql, artifact: ContextArtifact): Promise<ContextArtifact> {
    requireContextValue(validateContextArtifact(artifact), "artifact");
    const payload = canonicalContextJson(artifact);
    await putImmutableContextJson(db, 
      "context_artifacts",
      "org_id = $1 AND id = $2",
      [artifact.org_id, artifact.id],
      payload,
      "artifact",
      `
        INSERT INTO context_artifacts (
          org_id, id, kind, status, generation, recorded_at, payload_json
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [
        artifact.org_id,
        artifact.id,
        artifact.kind,
        artifact.status,
        artifact.generation,
        artifact.recorded_at,
        payload,
      ],
    );
    await db.execute(
      `INSERT INTO context_artifact_states (org_id, artifact_id, status, decided_at) VALUES ($1, $2, $3, $4) ON CONFLICT (org_id, artifact_id) DO NOTHING`,
      [artifact.org_id, artifact.id, artifact.status, artifact.recorded_at],
    );
    return parseContextJson<ContextArtifact>(payload);
  }

export async function getArtifact(db: PgSql, orgId: string, id: string): Promise<ContextArtifact | null> {
    const row = await db.queryOne<{ payload_json: unknown; lifecycle_status: ContextArtifact["status"] }>(
      `SELECT a.payload_json, s.status AS lifecycle_status FROM context_artifacts a JOIN context_artifact_states s ON s.org_id = a.org_id AND s.artifact_id = a.id WHERE a.org_id = $1 AND a.id = $2`,
      [orgId, id],
    );
    return row ? { ...parseContextJson<ContextArtifact>(row.payload_json), status: row.lifecycle_status } : null;
  }

export async function listArtifacts(db: PgSql, query: ContextArtifactQuery): Promise<ContextArtifact[]> {
    const validation = validateContextArtifactQuery(query);
    requireContextValue(validation, "artifact query");
    const stableQuery = validation.success ? validation.data : query;
    const params: unknown[] = [];
    const p = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    const clauses = [`a.org_id = ${p(stableQuery.org_id)}`];
    if (stableQuery.kinds) {
      if (stableQuery.kinds.length === 0) {
        return [];
      }
      clauses.push(
        `a.kind IN (${stableQuery.kinds.map((kind) => p(kind)).join(", ")})`,
      );
    }
    if (stableQuery.statuses) {
      if (stableQuery.statuses.length === 0) {
        return [];
      }
      clauses.push(
        `s.status IN (${stableQuery.statuses.map((status) => p(status)).join(", ")})`,
      );
    }
    if (stableQuery.generation) {
      clauses.push(`a.generation = ${p(stableQuery.generation)}`);
    }
    const limit = stableQuery.limit;
    const limitSql =
      typeof limit === "number" && Number.isFinite(limit)
        ? `LIMIT ${p(limit)}`
        : "";
    const rows = await db.query<{ payload_json: unknown; lifecycle_status: ContextArtifact["status"] }>(
      `
        SELECT a.payload_json, s.status AS lifecycle_status FROM context_artifacts a
        JOIN context_artifact_states s ON s.org_id = a.org_id AND s.artifact_id = a.id
        WHERE ${clauses.join(" AND ")}
        ORDER BY a.recorded_at ASC, a.id ASC
        ${limitSql}
      `,
      params,
    );
    return rows.map((row) => ({ ...parseContextJson<ContextArtifact>(row.payload_json), status: row.lifecycle_status }));
  }

export async function getArtifactState(db: PgSql, orgId: string, artifactId: string): Promise<ContextArtifactState | null> {
    const row = await db.queryOne<ArtifactStateRow>(
      `SELECT org_id, artifact_id, status, decided_at, superseded_by FROM context_artifact_states WHERE org_id = $1 AND artifact_id = $2`,
      [orgId, artifactId],
    );
    return row ? artifactState(row) : null;
  }

export async function decideArtifact(db: PgSql, input: ContextArtifactDecision): Promise<ContextArtifactState> {
    assertArtifactDecision(input);
    return db.withTx(async (client) => {
      const state = await transitionableArtifact(db, input.org_id, input.artifact_id, client);
      await db.execute(`UPDATE context_artifact_states SET status = $1, decided_at = $2, superseded_by = NULL WHERE org_id = $3 AND artifact_id = $4`, [input.status, input.decided_at, input.org_id, input.artifact_id], client);
      return { ...state, status: input.status, decided_at: input.decided_at } as ContextArtifactState;
    });
  }

export async function supersedeArtifact(db: PgSql, input: ContextArtifactSupersession): Promise<{ superseded: ContextArtifactState; accepted: ContextArtifactState }> {
    assertArtifactSupersession(input);
    return db.withTx(async (client) => {
      const current = await db.queryOne<ArtifactStateRow>(`SELECT org_id, artifact_id, status, decided_at, superseded_by FROM context_artifact_states WHERE org_id = $1 AND artifact_id = $2 FOR UPDATE`, [input.org_id, input.artifact_id], client);
      const replacement = await transitionableArtifact(db, input.org_id, input.replacement_id, client);
      const artifactRow = await db.queryOne<{ payload_json: unknown }>(
        `SELECT payload_json FROM context_artifacts WHERE org_id = $1 AND id = $2`,
        [input.org_id, input.replacement_id],
        client,
      );
      const artifact = artifactRow
        ? parseContextJson<ContextArtifact>(artifactRow.payload_json)
        : null;
      if (!current || current.status !== "accepted" || !artifact || artifact.supersedes_id !== input.artifact_id) throw new Error("Invalid Context artifact supersession");
      await db.execute(`UPDATE context_artifact_states SET status = 'superseded', decided_at = $1, superseded_by = $2 WHERE org_id = $3 AND artifact_id = $4`, [input.decided_at, input.replacement_id, input.org_id, input.artifact_id], client);
      await db.execute(`UPDATE context_artifact_states SET status = 'accepted', decided_at = $1, superseded_by = NULL WHERE org_id = $2 AND artifact_id = $3`, [input.decided_at, input.org_id, input.replacement_id], client);
      return {
        superseded: { ...artifactState(current), status: "superseded", decided_at: input.decided_at, superseded_by: input.replacement_id },
        accepted: { ...replacement, status: "accepted", decided_at: input.decided_at },
      };
    });
  }

export async function supersedeProposedArtifact(db: PgSql, input: ContextArtifactProposedSupersession): Promise<{ superseded: ContextArtifactState; replacement: ContextArtifactState }> {
    return db.withTx(async (client) => {
      const current = await db.queryOne<ArtifactStateRow>(`SELECT org_id, artifact_id, status, decided_at, superseded_by FROM context_artifact_states WHERE org_id = $1 AND artifact_id = $2 FOR UPDATE`, [input.org_id, input.artifact_id], client);
      const replacement = await transitionableArtifact(db, input.org_id, input.replacement_id, client);
      const artifacts = await db.query<{ id: string; payload_json: unknown }>(
        `SELECT id, payload_json FROM context_artifacts WHERE org_id = $1 AND id = ANY($2::text[])`,
        [input.org_id, [input.artifact_id, input.replacement_id]],
        client,
      );
      const byId = new Map(artifacts.map((row) => [row.id, parseContextJson<ContextArtifact>(row.payload_json)] as const));
      const currentArtifact = byId.get(input.artifact_id);
      const replacementArtifact = byId.get(input.replacement_id);
      if (!current || current.status !== "proposed" || !currentArtifact || !replacementArtifact || currentArtifact.kind !== "daily_digest" || replacementArtifact.kind !== "daily_digest" || replacementArtifact.supersedes_id !== input.artifact_id) throw new Error("Invalid proposed daily digest supersession");
      await db.execute(`UPDATE context_artifact_states SET status = 'superseded', decided_at = $1, superseded_by = $2 WHERE org_id = $3 AND artifact_id = $4`, [input.decided_at, input.replacement_id, input.org_id, input.artifact_id], client);
      await db.execute(`UPDATE context_artifact_states SET status = 'proposed', decided_at = $1, superseded_by = NULL WHERE org_id = $2 AND artifact_id = $3`, [input.decided_at, input.org_id, input.replacement_id], client);
      return {
        superseded: { ...artifactState(current), status: "superseded", decided_at: input.decided_at, superseded_by: input.replacement_id },
        replacement: { ...replacement, status: "proposed", decided_at: input.decided_at },
      };
    });
  }

export async function putSnapshot(db: PgSql, snapshot: ContextSnapshot): Promise<void> {
    requireContextValue(validateContextSnapshot(snapshot), "snapshot");
    const payload = canonicalContextJson(snapshot);
    await putImmutableContextJson(db, 
      "context_snapshots",
      "org_id = $1 AND id = $2",
      [snapshot.org_id, snapshot.id],
      payload,
      "snapshot",
      "INSERT INTO context_snapshots (org_id, id, payload_json) VALUES ($1, $2, $3)",
      [snapshot.org_id, snapshot.id, payload],
    );
  }

export async function getSnapshot(db: PgSql, orgId: string, id: string): Promise<ContextSnapshot | null> {
    return getContextJson<ContextSnapshot>(db, 
      "context_snapshots",
      "org_id = $1 AND id = $2",
      [orgId, id],
    );
  }

export async function putBundle(db: PgSql, bundle: ContextBundle): Promise<void> {
    requireContextValue(validateContextBundle(bundle), "bundle");
    const payload = canonicalContextJson(bundle);
    const lookup = [
      bundle.org_id,
      bundle.snapshot_id,
      bundle.principal.actor_type,
      bundle.principal.actor_id,
      bundle.consumer_id,
    ];
    await putImmutableContextJson(db, 
      "context_bundles",
      `
        org_id = $1 AND snapshot_id = $2 AND principal_actor_type = $3
        AND principal_actor_id = $4 AND consumer_id = $5
      `,
      lookup,
      payload,
      "bundle",
      `
        INSERT INTO context_bundles (
          org_id, snapshot_id, principal_actor_type, principal_actor_id,
          consumer_id, payload_json
        ) VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [...lookup, payload],
    );
  }

export async function getBundle(db: PgSql, query: ContextBundleLookup): Promise<ContextBundle | null> {
    return getContextJson<ContextBundle>(db, 
      "context_bundles",
      `
        org_id = $1 AND snapshot_id = $2 AND principal_actor_type = $3
        AND principal_actor_id = $4 AND consumer_id = $5
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

export async function putCheckpoint(db: PgSql, checkpoint: ContextProjectionCheckpoint): Promise<void> {
    const validation = validateContextProjectionCheckpoint(checkpoint);
    requireContextValue(validation, "projection checkpoint");
    const stableCheckpoint = validation.success ? validation.data : checkpoint;
    await db.withTx(async (client) => {
      const current = await db.queryOne<{ payload_json: unknown }>(
        `
          SELECT payload_json FROM context_projection_checkpoints
          WHERE org_id = $1 AND projector_id = $2 AND generation = $3
        `,
        [
          stableCheckpoint.org_id,
          stableCheckpoint.projector_id,
          stableCheckpoint.generation,
        ],
        client,
      );
      if (current) {
        const stored = parseContextJson<ContextProjectionCheckpoint>(
          current.payload_json,
        );
        if (stored.algorithm_version !== stableCheckpoint.algorithm_version) {
          throw new Error(
            "Projection checkpoint algorithm cannot change within a generation",
          );
        }
        if (stored.sequence > stableCheckpoint.sequence) {
          throw new Error("Projection checkpoint cannot move backwards");
        }
        if (stored.sequence === stableCheckpoint.sequence) {
          if (
            canonicalContextJson(stored) !==
            canonicalContextJson(stableCheckpoint)
          ) {
            throw new Error(
              "Projection checkpoint cannot change at the same sequence",
            );
          }
          return;
        }
      }
      const payload = canonicalContextJson(stableCheckpoint);
      await db.execute(
        `
          INSERT INTO context_projection_checkpoints (
            org_id, projector_id, generation, algorithm_version,
            sequence, watermark, updated_at, payload_json
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (org_id, projector_id, generation) DO UPDATE SET
            algorithm_version = EXCLUDED.algorithm_version,
            sequence = EXCLUDED.sequence,
            watermark = EXCLUDED.watermark,
            updated_at = EXCLUDED.updated_at,
            payload_json = EXCLUDED.payload_json
        `,
        [
          stableCheckpoint.org_id,
          stableCheckpoint.projector_id,
          stableCheckpoint.generation,
          stableCheckpoint.algorithm_version,
          stableCheckpoint.sequence,
          stableCheckpoint.watermark,
          stableCheckpoint.updated_at,
          payload,
        ],
        client,
      );
    });
  }

export async function getCheckpoint(db: PgSql, orgId: string, projectorId: string, generation: string): Promise<ContextProjectionCheckpoint | null> {
    return getContextJson<ContextProjectionCheckpoint>(db, 
      "context_projection_checkpoints",
      "org_id = $1 AND projector_id = $2 AND generation = $3",
      [orgId, projectorId, generation],
    );
  }

async function transitionableArtifact(db: PgSql, orgId: string, artifactId: string, client: PoolClient): Promise<ContextArtifactState> {
    const row = await db.queryOne<ArtifactStateRow>(
      `SELECT org_id, artifact_id, status, decided_at, superseded_by FROM context_artifact_states WHERE org_id = $1 AND artifact_id = $2 FOR UPDATE`,
      [orgId, artifactId],
      client,
    );
    const state = row ? artifactState(row) : null;
    if (!state || !["proposed", "needs_clarify"].includes(state.status)) {
      throw new Error("Context artifact is not transitionable");
    }
    return state;
  }

async function getContextJson<T>(db: PgSql, table: string, where: string, params: unknown[]): Promise<T | null> {
    const row = await db.queryOne<{ payload_json: unknown }>(
      `SELECT payload_json FROM ${table} WHERE ${where}`,
      params,
    );
    return row ? parseContextJson<T>(row.payload_json) : null;
  }

async function putImmutableContextJson(db: PgSql, table: string, where: string, lookupParams: unknown[], payload: string, label: string, insertSql: string, insertParams: unknown[]): Promise<void> {
    await db.withTx(async (client) => {
      const current = await db.queryOne<{ payload_json: unknown }>(
        `SELECT payload_json FROM ${table} WHERE ${where}`,
        lookupParams,
        client,
      );
      if (current) {
        if (canonicalContextJson(parseContextJson(current.payload_json)) !== payload) {
          throw new Error(`Cannot replace immutable context ${label}`);
        }
        return;
      }
      await db.execute(insertSql, insertParams, client);
    });
  }

export function toCatalogSnapshot(db: PgSql, row: CatalogCursorRow): SyncCatalogSnapshot {
    return {
      installation_id: row.installation_id,
      ...(row.cursor_value ? { cursor: row.cursor_value } : {}),
      complete: asBool(row.complete),
      generation: asNumber(row.generation),
      updated_at: toIso(row.updated_at),
    };
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

export function parseContextJson<T>(value: unknown): T {
  return asJson<T>(value);
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
