import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { load as loadSqliteVec } from "sqlite-vec";
import { definePlugin } from "@regenic/plugin-host";
import {
  canonicalContextJson,
  contextVectorAuthorizationAccumulator,
  contextVectorAuthorizationHashFromAccumulator,
  embeddingGeneration,
  updateContextVectorAuthorizationAccumulator,
  validateEmbeddingVector,
  ContextVectorUnavailableError,
  EmbeddingGenerationNotReadyError,
  scoreContextLexicalText,
  type ContextChunkOrigin,
  type ContextVectorMatch,
  type ContextVectorIndex,
  type ContextVectorGenerationStore,
  type ContextVectorChunk,
  type ContextVectorAuthorizationKey,
  type EmbeddingGeneration,
  type EmbeddingJob,
  type EmbeddingJobSummary,
  type EmbeddingJobStore,
  type EmbeddingSourceHead,
  type RankedHeadQuery,
  authorizedHeadFilterKey,
  authorizedHeadScopeKey,
  authorizedHeadWhere,
  authorityEventsAfterSql,
  authorityHeadPageSql,
  authorityHeadQualifyFrom,
} from "@regenic/domain";

export class VectorIndexSchemaError extends Error {}

function parseOrigin(json: string | null, hash: string, length: number): ContextChunkOrigin | undefined {
  if (json === null) return undefined;
  let value: ContextChunkOrigin;
  try {
    value = JSON.parse(json);
  } catch (error) {
    if (error instanceof SyntaxError) throw new ContextVectorUnavailableError("corrupt");
    throw error;
  }
  if (!value || !Number.isSafeInteger(value.part_index) || value.part_index < -1 ||
    !validHash(value.content_hash) || !Number.isSafeInteger(value.start) || value.start < 0 ||
    (value.mode !== "text" && value.mode !== "visual") ||
    (value.mode === "text" && (typeof value.text !== "string" || value.text.length !== length)) ||
    (value.mode === "visual" && (value.text !== undefined || length !== 1)) ||
    createHash("sha256").update(value.mode === "text" ? value.text! : `${value.content_hash}:${value.start}`).digest("hex") !== hash) {
    throw new ContextVectorUnavailableError("corrupt");
  }
  return value;
}

interface JobRow {
  id: number; org_id: string; generation: string; source: string; external_id: string;
  event_id: string; content_hash: string | null; operation: EmbeddingJob["operation"];
  lineage_json: string; fence: number; attempts: number; status: EmbeddingJob["status"]; error_code: string | null;
  started_at: string | null; completed_at: string | null; processing_ms: number; lease_until: string | null;
}

interface AuthorizedChunkRow {
  event_id: string;
  content_hash: string;
  body_length: number | null;
  chunk_count: number;
  ordinal: number | null;
  start: number | null;
  end: number | null;
  vector: Buffer | null;
  origin_json: string | null;
  text_hash: string;
}

interface VectorAuthorizationStateRow {
  org_id: string;
  generation: string;
  authorization_hash: string;
  authorization_accumulator: string | null;
  authorized_count: number;
  covered_count: number;
  native_chunk_count: number;
  projection_revision: number;
}

const NATIVE_KNN_PARTITIONS = [
  "vector_authorized_knn_messages",
  "vector_authorized_knn_files",
  "vector_authorized_knn_rest",
] as const;

type NativeKnnPartition = (typeof NATIVE_KNN_PARTITIONS)[number];

interface NativeVectorCandidateRow {
  event_id: string;
  distance: number;
}

export class SqliteContextVectorIndex implements ContextVectorIndex, ContextVectorGenerationStore, EmbeddingJobStore {
  private readonly db: Database.Database;
  private readonly nativeVectors: boolean;
  /** Stamp, filters, and generation already staged into the temp knn table. */
  private rankedScopeKey: string | undefined;
  /** Filter scope of the staged knn table. A sync stamp change does not rebuild it. */
  private rankedFilterKey: string | undefined;
  /** One authorized-index build at a time. Search waits; it does not start a second copy. */
  private knnMaintenance: Promise<void> | null = null;
  /** One ranked-index build at a time, shared by startup and search. */
  private rankedWarm: Promise<void> | null = null;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    try {
      this.nativeVectors = this.loadNativeVectors();
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("foreign_keys = ON");
      this.db.pragma("secure_delete = ON");
      this.db.pragma("busy_timeout = 5000");
      const version = this.db.pragma("user_version", { simple: true });
      if (version !== 0 && version !== 1 && version !== 2 && version !== 3 && version !== 4 && version !== 5 && version !== 6 && version !== 7 && version !== 8 && version !== 9) throw new VectorIndexSchemaError("Unsupported vector index schema");
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS generations (
            org_id TEXT NOT NULL, generation TEXT NOT NULL, manifest_json TEXT NOT NULL, reconciled_epoch TEXT,
            reconciled_sequence INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (org_id, generation)
          );
          CREATE TABLE IF NOT EXISTS source_heads (
            org_id TEXT NOT NULL, source TEXT NOT NULL, external_id TEXT NOT NULL,
            event_id TEXT NOT NULL, fence INTEGER NOT NULL,
            PRIMARY KEY (org_id, source, external_id)
          );
          CREATE TABLE IF NOT EXISTS jobs (
            id INTEGER PRIMARY KEY AUTOINCREMENT, org_id TEXT NOT NULL, generation TEXT NOT NULL,
            source TEXT NOT NULL, external_id TEXT NOT NULL, event_id TEXT NOT NULL, content_hash TEXT,
            operation TEXT NOT NULL, lineage_json TEXT NOT NULL, fence INTEGER NOT NULL,
            status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
            owner TEXT, lease_until TEXT, retry_at TEXT, error_code TEXT,
            started_at TEXT, completed_at TEXT, processing_ms INTEGER NOT NULL DEFAULT 0, lane TEXT,
            UNIQUE (org_id, generation, event_id),
            FOREIGN KEY (org_id, generation) REFERENCES generations(org_id, generation) ON DELETE CASCADE
          );
          CREATE INDEX IF NOT EXISTS jobs_due ON jobs(org_id, generation, status, retry_at, lease_until, id);
          CREATE INDEX IF NOT EXISTS jobs_pending_id ON jobs(org_id, generation, id) WHERE status='pending';
          CREATE INDEX IF NOT EXISTS jobs_running_lease ON jobs(org_id, generation, lease_until) WHERE status='running';
          DROP INDEX IF EXISTS jobs_failed_id;
          DROP INDEX IF EXISTS jobs_running_id;
          CREATE TABLE IF NOT EXISTS staged_chunks (
            job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
            ordinal INTEGER NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL,
            text_hash TEXT NOT NULL, vector BLOB NOT NULL,
            PRIMARY KEY (job_id, ordinal)
          );
          CREATE TABLE IF NOT EXISTS coverage (
            org_id TEXT NOT NULL, generation TEXT NOT NULL, event_id TEXT NOT NULL,
            content_hash TEXT NOT NULL, source TEXT NOT NULL, external_id TEXT NOT NULL, chunk_count INTEGER NOT NULL,
            PRIMARY KEY (org_id, generation, event_id),
            FOREIGN KEY (org_id, generation) REFERENCES generations(org_id, generation) ON DELETE CASCADE
          );
          CREATE TABLE IF NOT EXISTS chunks (
            org_id TEXT NOT NULL, generation TEXT NOT NULL, event_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
            start INTEGER NOT NULL, end INTEGER NOT NULL, text_hash TEXT NOT NULL, vector BLOB NOT NULL,
            PRIMARY KEY (org_id, generation, event_id, ordinal),
            FOREIGN KEY (org_id, generation, event_id) REFERENCES coverage(org_id, generation, event_id) ON DELETE CASCADE
          );
          CREATE TABLE IF NOT EXISTS active_generations (
            org_id TEXT PRIMARY KEY, generation TEXT NOT NULL,
            FOREIGN KEY (org_id, generation) REFERENCES generations(org_id, generation) ON DELETE CASCADE
          );
          CREATE TABLE IF NOT EXISTS retired_generations (
            org_id TEXT NOT NULL, generation TEXT NOT NULL, manifest_json TEXT NOT NULL, retired_at TEXT NOT NULL,
            PRIMARY KEY (org_id, generation)
          );
          CREATE TABLE IF NOT EXISTS generation_activations (
            org_id TEXT NOT NULL, generation TEXT NOT NULL,
            PRIMARY KEY (org_id, generation),
            FOREIGN KEY (org_id, generation) REFERENCES generations(org_id, generation) ON DELETE CASCADE
          );
          INSERT OR IGNORE INTO generation_activations SELECT org_id,generation FROM active_generations;
          CREATE TABLE IF NOT EXISTS visual_policies (
            org_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL CHECK (enabled IN (0,1))
          );
          CREATE TABLE IF NOT EXISTS vector_projection_revisions (
            org_id TEXT NOT NULL,
            generation TEXT NOT NULL,
            revision INTEGER NOT NULL CHECK (revision >= 0),
            PRIMARY KEY (org_id,generation),
            FOREIGN KEY (org_id,generation) REFERENCES generations(org_id,generation) ON DELETE CASCADE
          );
          CREATE TABLE IF NOT EXISTS vector_projection_changes (
            org_id TEXT NOT NULL,
            generation TEXT NOT NULL,
            event_id TEXT NOT NULL,
            revision INTEGER NOT NULL CHECK (revision > 0),
            PRIMARY KEY (org_id,generation,event_id),
            FOREIGN KEY (org_id,generation) REFERENCES generations(org_id,generation) ON DELETE CASCADE
          );
          CREATE INDEX IF NOT EXISTS vector_projection_changes_revision_idx
            ON vector_projection_changes(org_id,generation,revision);
          INSERT OR IGNORE INTO vector_projection_revisions(org_id,generation,revision)
            SELECT org_id,generation,0 FROM generations;
          CREATE TABLE IF NOT EXISTS vector_authorized (
            event_id TEXT PRIMARY KEY,
            content_hash TEXT NOT NULL,
            body_length INTEGER
          ) WITHOUT ROWID;
          CREATE TABLE IF NOT EXISTS vector_uncovered (
            event_id TEXT PRIMARY KEY,
            content_hash TEXT NOT NULL
          ) WITHOUT ROWID;
          CREATE TABLE IF NOT EXISTS vector_skipped (
            event_id TEXT PRIMARY KEY,
            content_hash TEXT NOT NULL
          ) WITHOUT ROWID;
          CREATE TABLE IF NOT EXISTS vector_authorized_native_rows (
            event_id TEXT NOT NULL,
            rowid INTEGER NOT NULL,
            PRIMARY KEY (event_id,rowid)
          ) WITHOUT ROWID;
          CREATE TABLE IF NOT EXISTS vector_knn_meta (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            dimensions INTEGER NOT NULL CHECK (dimensions > 0)
          ) WITHOUT ROWID;
          CREATE TABLE IF NOT EXISTS vector_ranked_scope (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            org_id TEXT NOT NULL,
            generation TEXT NOT NULL,
            filter_key TEXT NOT NULL,
            scope_key TEXT NOT NULL,
            dimensions INTEGER NOT NULL CHECK (dimensions > 0),
            native_chunk_count INTEGER NOT NULL CHECK (native_chunk_count >= 0),
            head_sequence INTEGER,
            head_count INTEGER
          ) WITHOUT ROWID;
          CREATE TEMP TABLE IF NOT EXISTS vector_ranked_native_rows (
            event_id TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            rowid INTEGER NOT NULL,
            PRIMARY KEY (event_id, rowid)
          ) WITHOUT ROWID;
          CREATE TEMP TABLE IF NOT EXISTS vector_authorized_next (
            event_id TEXT PRIMARY KEY,
            content_hash TEXT NOT NULL,
            body_length INTEGER
          ) WITHOUT ROWID;
          CREATE TEMP TABLE IF NOT EXISTS vector_head_tail (
            event_id TEXT PRIMARY KEY
          ) WITHOUT ROWID;
          CREATE TEMP TABLE IF NOT EXISTS vector_knn_backfill_batch (
            event_id TEXT NOT NULL,
            ordinal INTEGER NOT NULL,
            chunk_rowid INTEGER NOT NULL PRIMARY KEY
          );
          CREATE TABLE IF NOT EXISTS vector_authorization_state (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            org_id TEXT NOT NULL,
            generation TEXT NOT NULL,
            authorization_hash TEXT NOT NULL,
            authorization_accumulator TEXT,
            authorized_count INTEGER NOT NULL CHECK (authorized_count >= 0),
            covered_count INTEGER NOT NULL CHECK (
              covered_count >= 0 AND covered_count <= authorized_count
            ),
            native_chunk_count INTEGER NOT NULL CHECK (native_chunk_count >= 0),
            projection_revision INTEGER NOT NULL CHECK (projection_revision >= 0)
          ) WITHOUT ROWID;
        `);
        if (version !== 5) {
          for (const table of ["chunks", "staged_chunks"]) {
            const columns = this.db.pragma(`table_info(${table})`) as Array<{ name: string }>;
            if (!columns.some((column) => column.name === "origin_json")) {
              this.db.exec(`ALTER TABLE ${table} ADD COLUMN origin_json TEXT;`);
            }
          }
        }
        if (version < 6) {
          const columns = this.db.pragma("table_info(jobs)") as Array<{ name: string }>;
          if (!columns.some((column) => column.name === "started_at")) {
            this.db.exec("ALTER TABLE jobs ADD COLUMN started_at TEXT;");
          }
          if (!columns.some((column) => column.name === "completed_at")) {
            this.db.exec("ALTER TABLE jobs ADD COLUMN completed_at TEXT;");
          }
          if (!columns.some((column) => column.name === "processing_ms")) {
            this.db.exec("ALTER TABLE jobs ADD COLUMN processing_ms INTEGER NOT NULL DEFAULT 0;");
          }
          this.db.exec("UPDATE jobs SET started_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE status='running' AND started_at IS NULL;");
        }
        const jobColumns = this.db.pragma("table_info(jobs)") as Array<{ name: string }>;
        if (!jobColumns.some((column) => column.name === "lane")) {
          this.db.exec("ALTER TABLE jobs ADD COLUMN lane TEXT;");
        }
        this.db.exec(`
          CREATE INDEX IF NOT EXISTS jobs_pending_fast ON jobs(org_id, generation, id) WHERE status='pending' AND lane IS NULL;
          CREATE INDEX IF NOT EXISTS jobs_pending_slow ON jobs(org_id, generation, id) WHERE status='pending' AND lane='slow';
        `);
        const generationColumns = this.db.pragma("table_info(generations)") as Array<{ name: string }>;
        if (!generationColumns.some((column) => column.name === "reconciled_sequence")) {
          this.db.exec("ALTER TABLE generations ADD COLUMN reconciled_sequence INTEGER NOT NULL DEFAULT 0;");
        }
        const scopeColumns = this.db.pragma("table_info(vector_ranked_scope)") as Array<{ name: string }>;
        if (!scopeColumns.some((column) => column.name === "head_sequence")) {
          this.db.exec("ALTER TABLE vector_ranked_scope ADD COLUMN head_sequence INTEGER;");
        }
        if (!scopeColumns.some((column) => column.name === "head_count")) {
          this.db.exec("ALTER TABLE vector_ranked_scope ADD COLUMN head_count INTEGER;");
        }
        this.db.pragma("user_version = 9");
      }).immediate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void { if (this.db.open) this.db.close(); }

  private immediate<T>(work: () => T): T {
    return this.db.inTransaction ? work() : this.db.transaction(work).immediate();
  }

  async setVisualEnabled(orgId: string, enabled: boolean): Promise<void> {
    required(orgId);
    if (typeof enabled !== "boolean") throw new Error("Invalid visual processing permission");
    this.db.transaction(() => {
      const previous = this.db.prepare("SELECT enabled FROM visual_policies WHERE org_id=?")
        .get(orgId) as { enabled: number } | undefined;
      if (previous?.enabled === Number(enabled)) return;
      this.invalidateVectorAuthorization();
      if (!enabled) {
        const readChunks = this.db.prepare(`
          SELECT ordinal,start,end,origin_json FROM chunks
          WHERE org_id=? AND generation=? AND event_id=? ORDER BY ordinal
        `);
        const deleteChunk = this.db.prepare("DELETE FROM chunks WHERE org_id=? AND generation=? AND event_id=? AND ordinal=?");
        const updateChunk = this.db.prepare(`UPDATE chunks SET ordinal=?,start=?,end=?
          WHERE org_id=? AND generation=? AND event_id=? AND ordinal=?`);
        const deleteCoverage = this.db.prepare("DELETE FROM coverage WHERE org_id=? AND generation=? AND event_id=?");
        const updateCoverage = this.db.prepare("UPDATE coverage SET chunk_count=? WHERE org_id=? AND generation=? AND event_id=?");
        const skipJob = this.db.prepare(`UPDATE jobs SET status='skipped'
          WHERE org_id=? AND generation=? AND event_id=? AND status='succeeded'`);
        const groups = this.db.prepare(`
          SELECT DISTINCT generation,event_id FROM chunks
          WHERE org_id=? AND json_extract(origin_json,'$.mode')='visual'
        `).all(orgId) as Array<{ generation: string; event_id: string }>;
        for (const group of groups) {
          const rows = readChunks.all(orgId, group.generation, group.event_id) as Array<{
            ordinal: number; start: number; end: number; origin_json: string | null;
          }>;
          let ordinal = 0;
          let cursor = 0;
          for (const row of rows) {
            const origin = row.origin_json === null ? undefined : JSON.parse(row.origin_json) as { mode?: string };
            if (origin?.mode === "visual") {
              deleteChunk.run(orgId, group.generation, group.event_id, row.ordinal);
              continue;
            }
            const length = row.end - row.start;
            updateChunk.run(ordinal++, cursor, cursor + length, orgId, group.generation, group.event_id, row.ordinal);
            cursor += length;
          }
          if (ordinal === 0) {
            deleteCoverage.run(orgId, group.generation, group.event_id);
            skipJob.run(orgId, group.generation, group.event_id);
          } else {
            updateCoverage.run(ordinal, orgId, group.generation, group.event_id);
          }
          this.recordProjectionChange(
            orgId,
            group.generation,
            group.event_id,
          );
        }
      }
      // Permission changes invalidate checkpoint offsets, not retained text vectors.
      this.db.prepare("DELETE FROM staged_chunks WHERE job_id IN (SELECT id FROM jobs WHERE org_id=?)").run(orgId);
      this.db.prepare(`UPDATE jobs SET status='pending',owner=NULL,lease_until=NULL,retry_at=NULL,
        error_code=NULL,started_at=NULL,completed_at=NULL,attempts=0
        WHERE org_id=? AND operation!='tombstone' AND status!='superseded'
        AND (?=1 OR status='running')`).run(orgId, enabled && previous?.enabled === 0 ? 1 : 0);
      this.db.prepare("INSERT OR REPLACE INTO visual_policies(org_id,enabled) VALUES (?,?)")
        .run(orgId, Number(enabled));
    }).immediate();
    if (!enabled) {
      const checkpoint = this.db.pragma("wal_checkpoint(TRUNCATE)") as Array<{ busy: number }>;
      if (checkpoint.some((row) => row.busy !== 0)) throw new Error("Visual index deletion checkpoint is busy");
    }
  }

  async registerGeneration(orgId: string, generation: EmbeddingGeneration): Promise<void> {
    required(orgId);
    const expected = embeddingGeneration(
      generation.model, generation.chunk_tokens, generation.max_chunks_per_event, generation.extractor_version,
    );
    if (canonicalContextJson(generation) !== canonicalContextJson(expected)) throw new Error("Invalid vector generation manifest");
    this.db.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM retired_generations WHERE org_id=? AND generation=?").get(orgId, generation.id)) {
        throw new Error("Generation was collected; use a new recipe or explicitly clear the projection");
      }
      this.db.prepare("INSERT OR IGNORE INTO generations(org_id,generation,manifest_json) VALUES (?,?,?)")
        .run(orgId, generation.id, canonicalContextJson(generation));
      this.manifest(orgId, generation.id);
      this.db.prepare(
        "INSERT OR IGNORE INTO vector_projection_revisions(org_id,generation,revision) VALUES (?,?,0)",
      ).run(orgId, generation.id);
      this.db.prepare("INSERT OR IGNORE INTO active_generations VALUES (?,?)").run(orgId, generation.id);
      this.db.prepare(`INSERT OR IGNORE INTO generation_activations
        SELECT org_id,generation FROM active_generations WHERE org_id=?`).run(orgId);
    }).immediate();
  }

  async listGenerations(orgId: string): ReturnType<ContextVectorGenerationStore["listGenerations"]> {
    required(orgId);
    const rows = this.db.prepare(`SELECT g.generation,g.reconciled_epoch,
      CASE WHEN a.generation=g.generation THEN 1 ELSE 0 END AS active
      FROM generations g LEFT JOIN active_generations a ON a.org_id=g.org_id
      WHERE g.org_id=? ORDER BY g.generation`).all(orgId) as Array<{
        generation: string; reconciled_epoch: string | null; active: number;
      }>;
    return rows.map((row) => ({
      manifest: this.manifest(orgId, row.generation), active: row.active === 1,
      previously_active: Boolean(this.db.prepare(
        "SELECT 1 FROM generation_activations WHERE org_id=? AND generation=?",
      ).get(orgId, row.generation)),
      ...(row.reconciled_epoch ? { reconciled_epoch: row.reconciled_epoch } : {}),
    }));
  }

  async activeGeneration(orgId: string): Promise<EmbeddingGeneration | undefined> {
    required(orgId);
    try {
      const row = this.db.prepare("SELECT generation FROM active_generations WHERE org_id=?").get(orgId) as
        { generation: string } | undefined;
      return row ? this.manifest(orgId, row.generation) : undefined;
    } catch (error) {
      if (error instanceof Database.SqliteError) throw new ContextVectorUnavailableError("unavailable");
      throw error;
    }
  }

  async activateGeneration(input: Parameters<ContextVectorGenerationStore["activateGeneration"]>[0]): Promise<void> {
    required(input.org_id); required(input.generation); required(input.read_epoch);
    const ids = new Set<string>();
    for (const key of input.required) {
      required(key.event_id);
      if (!validHash(key.content_hash) || ids.has(key.event_id)) throw new Error("Invalid generation coverage proof");
      ids.add(key.event_id);
    }
    this.db.transaction(() => {
      const manifest = this.manifest(input.org_id, input.generation);
      const row = this.db.prepare("SELECT reconciled_epoch FROM generations WHERE org_id=? AND generation=?")
        .get(input.org_id, input.generation) as { reconciled_epoch: string | null };
      if (row.reconciled_epoch !== input.read_epoch) throw new EmbeddingGenerationNotReadyError("authority_changed");
      for (const key of input.required) {
        const coverage = this.db.prepare(`SELECT c.chunk_count FROM coverage c JOIN source_heads h
          ON h.org_id=c.org_id AND h.source=c.source AND h.external_id=c.external_id AND h.event_id=c.event_id
          WHERE c.org_id=? AND c.generation=? AND c.event_id=? AND c.content_hash=?`)
          .get(input.org_id, input.generation, key.event_id, key.content_hash) as { chunk_count: number } | undefined;
        if (!coverage) throw new EmbeddingGenerationNotReadyError("backfill_incomplete");
        const chunks = this.db.prepare("SELECT ordinal,start,end,vector FROM chunks WHERE org_id=? AND generation=? AND event_id=? ORDER BY ordinal")
          .all(input.org_id, input.generation, key.event_id) as Array<{ ordinal: number; start: number; end: number; vector: Buffer }>;
        let end = 0;
        if (chunks.length !== coverage.chunk_count || chunks.length < 1) throw new ContextVectorUnavailableError("corrupt");
        for (const [ordinal, chunk] of chunks.entries()) {
          if (chunk.ordinal !== ordinal || chunk.start !== end || chunk.end <= end ||
            chunk.vector.length !== manifest.model.dimensions * 4) throw new ContextVectorUnavailableError("corrupt");
          validateEmbeddingVector(Array.from({ length: manifest.model.dimensions },
            (_, index) => chunk.vector.readFloatLE(index * 4)), manifest.model.dimensions);
          end = chunk.end;
        }
      }
      this.db.prepare(`INSERT INTO active_generations VALUES (?,?)
        ON CONFLICT(org_id) DO UPDATE SET generation=excluded.generation`).run(input.org_id, input.generation);
      this.db.prepare("INSERT OR IGNORE INTO generation_activations VALUES (?,?)")
        .run(input.org_id, input.generation);
    }).immediate();
  }

  async removeGeneration(orgId: string, generation: string): Promise<void> {
    required(orgId); required(generation);
    this.db.transaction(() => {
      this.manifest(orgId, generation);
      if (this.db.prepare("SELECT 1 FROM active_generations WHERE org_id=? AND generation=?").get(orgId, generation)) {
        throw new Error("Cannot garbage-collect the active generation");
      }
      if (this.db.prepare("SELECT 1 FROM jobs WHERE org_id=? AND generation=? AND status='running' AND lease_until>?")
        .get(orgId, generation, new Date().toISOString())) throw new Error("Generation still has a live indexing lease");
      this.invalidateVectorAuthorization();
      this.db.prepare(`INSERT INTO retired_generations
        SELECT org_id,generation,manifest_json,? FROM generations WHERE org_id=? AND generation=?`)
        .run(new Date().toISOString(), orgId, generation);
      this.db.prepare("DELETE FROM generations WHERE org_id=? AND generation=?").run(orgId, generation);
    }).immediate();
  }

  async reconcile(input: Parameters<EmbeddingJobStore["reconcile"]>[0]): Promise<void> {
    required(input.org_id); required(input.read_epoch); timestamp(input.now);
    this.manifest(input.org_id, input.generation);
    const keys = new Set<string>();
    for (const head of input.heads) {
      required(head.source); required(head.external_id); required(head.event_id);
      const key = canonicalContextJson([head.source, head.external_id]);
      if (keys.has(key) || !["create", "revise", "tombstone"].includes(head.operation) ||
        !Array.isArray(head.lineage) || head.lineage.length === 0 || new Set(head.lineage).size !== head.lineage.length ||
        head.lineage.at(-1) !== head.event_id ||
        (head.operation !== "tombstone" && !validHash(head.content_hash))) throw new Error("Invalid embedding lifecycle");
      head.lineage.forEach(required);
      keys.add(key);
    }
    this.db.transaction(() => {
      const authorizationState = this.currentVectorAuthorizationState(
        input.org_id,
        input.generation,
      );
      let nativeChunkCount = authorizationState?.native_chunk_count ?? 0;
      let projectionRevision = authorizationState?.projection_revision;
      // Compiling these once matters: reconcile walks every lifecycle head, and
      // preparing inside the loop held the main thread for about a second.
      const previousHead = this.db.prepare(
        "SELECT event_id,fence FROM source_heads WHERE org_id=? AND source=? AND external_id=?",
      );
      const upsertHead = this.db.prepare(`INSERT INTO source_heads VALUES (?,?,?,?,?)
        ON CONFLICT(org_id,source,external_id) DO UPDATE SET event_id=excluded.event_id,fence=excluded.fence`);
      const deleteCoverage = this.db.prepare(
        "DELETE FROM coverage WHERE org_id=? AND source=? AND external_id=?",
      );
      const authorizedHash = this.db.prepare(
        "SELECT content_hash FROM vector_authorized WHERE event_id=?",
      );
      const insertUncovered = this.db.prepare(
        "INSERT OR REPLACE INTO vector_uncovered(event_id,content_hash) VALUES (?,?)",
      );
      const deleteSkipped = this.db.prepare("DELETE FROM vector_skipped WHERE event_id=?");
      const supersedeJobs = this.db.prepare(`UPDATE jobs SET status='superseded',owner=NULL,lease_until=NULL,
        processing_ms=processing_ms+CASE WHEN started_at IS NULL THEN 0
          ELSE MAX(0,CAST((julianday(?) - julianday(started_at))*86400000 AS INTEGER)) END,
        started_at=NULL,completed_at=?
        WHERE org_id=? AND source=? AND external_id=? AND event_id<>?`);
      const deleteStaged = this.db.prepare(`DELETE FROM staged_chunks WHERE job_id IN (
        SELECT id FROM jobs WHERE org_id=? AND source=? AND external_id=? AND status='superseded'
      )`);
      const insertJob = this.db.prepare(`INSERT OR IGNORE INTO jobs (
        org_id,generation,source,external_id,event_id,content_hash,operation,lineage_json,fence,status,completed_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
      const updateEpoch = this.db.prepare(
        "UPDATE generations SET reconciled_epoch=? WHERE org_id=? AND generation=?",
      );
      for (const head of input.heads) {
        const previous = previousHead.get(input.org_id, head.source, head.external_id) as
          { event_id: string; fence: number } | undefined;
        if (previous && !head.lineage.includes(previous.event_id)) throw new Error("Stale embedding lifecycle view");
        const fence = previous ? previous.fence + Number(previous.event_id !== head.event_id) : 1;
        upsertHead.run(input.org_id, head.source, head.external_id, head.event_id, fence);
        if (previous?.event_id !== head.event_id) {
          if (previous) {
            projectionRevision = this.recordProjectionChangesForOrganization(
              input.org_id,
              [previous.event_id, head.event_id],
            ).get(input.generation);
          }
          if (authorizationState && previous) {
            nativeChunkCount -= this.removeNativeAuthorizedEvent(
              input.org_id,
              input.generation,
              previous.event_id,
            );
          }
          deleteCoverage.run(input.org_id, head.source, head.external_id);
          const authorized = previous
            ? authorizedHash.get(previous.event_id) as { content_hash: string } | undefined
            : undefined;
          if (authorizationState && previous && authorized) {
            insertUncovered.run(previous.event_id, authorized.content_hash);
            deleteSkipped.run(previous.event_id);
          }
          supersedeJobs.run(input.now, input.now, input.org_id, head.source, head.external_id, head.event_id);
          deleteStaged.run(input.org_id, head.source, head.external_id);
        }
        insertJob.run(
          input.org_id, input.generation, head.source, head.external_id, head.event_id, head.content_hash ?? null,
          head.operation, canonicalContextJson(head.lineage), fence, head.operation === "tombstone" ? "succeeded" : "pending",
          head.operation === "tombstone" ? input.now : null,
        );
      }
      updateEpoch.run(input.read_epoch, input.org_id, input.generation);
      if (authorizationState) {
        this.updateVectorAuthorizationCounts(nativeChunkCount, projectionRevision);
      }
    }).immediate();
  }

  async reconcileChanged(
    input: Parameters<NonNullable<EmbeddingJobStore["reconcileChanged"]>>[0],
  ): Promise<{ changed: number; done: boolean }> {
    required(input.org_id);
    required(input.read_epoch);
    timestamp(input.now);
    this.manifest(input.org_id, input.generation);
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 500) {
      throw new Error("Invalid embedding reconcile page");
    }
    const selected: SequencedAuthorityHead[] = [];
    const chains: ChangedAuthorityChain[] = [];
    const branched = new Set<string>();
    let nextSequence = 0;
    let caughtUpToHead = false;
    withAttachedAuthority(this.db, input.authority_path, () => {
      const watermark = this.db.prepare(
        "SELECT reconciled_sequence FROM generations WHERE org_id=? AND generation=?",
      ).get(input.org_id, input.generation) as { reconciled_sequence: number | null };
      const latest = this.db.prepare(
        "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM regenic_auth.events WHERE org_id=?",
      ).get(input.org_id) as { sequence: number };
      const seen = watermark.reconciled_sequence ?? 0;
      if (seen >= latest.sequence) {
        caughtUpToHead = true;
        return;
      }
      selected.push(...this.db.prepare(`
        SELECT e.sequence, e.source, e.external_id, e.id AS event_id, e.operation, e.content_hash,
          e.parent_event_id, e.thread_id, e.actor_id, e.required_scope_ids_json,
          b.media_type,
          CASE WHEN j.event_id IS NULL THEN 0 ELSE 1 END AS has_job
        FROM regenic_auth.events e
        JOIN regenic_auth.source_heads h
          ON h.org_id = e.org_id AND h.source = e.source AND h.external_id = e.external_id
          AND h.current_event_id = e.id
        LEFT JOIN regenic_auth.blobs b ON b.content_hash = e.content_hash
        LEFT JOIN jobs j
          ON j.org_id = e.org_id AND j.generation = ? AND j.event_id = e.id
        WHERE e.org_id = ? AND e.sequence > ?
        ORDER BY e.sequence
        LIMIT ?
      `).all(input.generation, input.org_id, seen, input.limit + 1) as SequencedAuthorityHead[]);
      const page = selected.slice(0, input.limit);
      nextSequence = selected.length <= input.limit
        ? latest.sequence
        : page[page.length - 1]?.sequence ?? seen;
      const pendingIds = page.filter((row) => row.has_job !== 1).map((row) => row.event_id);
      if (pendingIds.length === 0) return;
      chains.push(...this.db.prepare(`
        WITH RECURSIVE chain AS (
          SELECT e.id, e.parent_event_id, e.operation, e.id AS head_id, 0 AS depth
          FROM regenic_auth.events e
          WHERE e.org_id = ? AND e.id IN (SELECT value FROM json_each(?))
          UNION ALL
          SELECT p.id, p.parent_event_id, p.operation, chain.head_id, chain.depth + 1
          FROM regenic_auth.events p
          JOIN chain ON p.id = chain.parent_event_id AND p.org_id = ?
          WHERE chain.depth < 32
        )
        SELECT head_id, id, parent_event_id, operation, depth FROM chain
      `).all(input.org_id, JSON.stringify(pendingIds), input.org_id) as ChangedAuthorityChain[]);
      const parents = this.db.prepare(`
        SELECT parent_event_id AS id
        FROM regenic_auth.events
        WHERE org_id = ? AND parent_event_id IN (SELECT value FROM json_each(?))
        GROUP BY parent_event_id
        HAVING COUNT(*) > 1
      `).all(input.org_id, JSON.stringify([
        ...pendingIds,
        ...chains.map((row) => row.id),
      ])) as Array<{ id: string }>;
      for (const parent of parents) {
        for (const row of chains) {
          if (row.id === parent.id || row.parent_event_id === parent.id) branched.add(row.head_id);
        }
      }
    });
    if (caughtUpToHead) return { changed: 0, done: true };
    const page = selected.slice(0, input.limit);
    const done = selected.length <= input.limit;
    const pending = page.filter((row) => row.has_job !== 1);
    if (page.length === 0) {
      this.rememberReconciledSequence(input.org_id, input.generation, nextSequence);
      return { changed: 0, done: true };
    }
    const lineageByHead = new Map<string, ChangedAuthorityChain[]>();
    for (const row of chains) {
      const group = lineageByHead.get(row.head_id) ?? [];
      group.push(row);
      lineageByHead.set(row.head_id, group);
    }
    const eligible: EmbeddingSourceHead[] = [];
    const caughtUp: ChangedAuthorityHead[] = [];
    for (const row of pending) {
      const lineage = lineageFor(lineageByHead.get(row.event_id) ?? [], row.event_id);
      if (!lineage || branched.has(row.event_id) || !changedHeadEligible(row)) {
        caughtUp.push(row);
        continue;
      }
      eligible.push({
        source: row.source,
        external_id: row.external_id,
        event_id: row.event_id,
        operation: row.operation as EmbeddingSourceHead["operation"],
        lineage,
        ...(row.operation === "tombstone" ? {} : { content_hash: row.content_hash! }),
      });
    }
    if (eligible.length > 0) {
      await this.reconcile({
        org_id: input.org_id,
        generation: input.generation,
        read_epoch: input.read_epoch,
        now: input.now,
        heads: eligible,
      });
    }
    if (caughtUp.length > 0) this.rememberCaughtUpHeads(input.org_id, input.generation, input.now, caughtUp);
    this.rememberReconciledSequence(input.org_id, input.generation, nextSequence);
    return { changed: page.length, done };
  }

  private rememberReconciledSequence(orgId: string, generation: string, sequence: number): void {
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error("Invalid authority event sequence");
    this.db.prepare(`UPDATE generations SET reconciled_sequence=?
      WHERE org_id=? AND generation=? AND reconciled_sequence<?`)
      .run(sequence, orgId, generation, sequence);
  }

  private rememberCaughtUpHeads(
    orgId: string,
    generation: string,
    now: string,
    heads: ChangedAuthorityHead[],
  ): void {
    const previous = this.db.prepare(
      "SELECT event_id, fence FROM source_heads WHERE org_id=? AND source=? AND external_id=?",
    );
    const upsert = this.db.prepare(`INSERT INTO source_heads VALUES (?,?,?,?,?)
      ON CONFLICT(org_id,source,external_id) DO UPDATE SET event_id=excluded.event_id, fence=excluded.fence`);
    const skip = this.db.prepare(`INSERT OR IGNORE INTO jobs (
      org_id,generation,source,external_id,event_id,content_hash,operation,lineage_json,fence,status,completed_at
    ) VALUES (?,?,?,?,?,?,?,?,?,'skipped',?)`);
    this.db.transaction(() => {
      for (const head of heads) {
        const prior = previous.get(orgId, head.source, head.external_id) as
          { event_id: string; fence: number } | undefined;
        const fence = prior ? prior.fence + Number(prior.event_id !== head.event_id) : 1;
        upsert.run(orgId, head.source, head.external_id, head.event_id, fence);
        const operation = head.operation === "revise" || head.operation === "tombstone" ? head.operation : "create";
        skip.run(
          orgId, generation, head.source, head.external_id, head.event_id,
          head.content_hash, operation, "[]", fence, now,
        );
      }
    }).immediate();
  }

  async claim(input: Parameters<EmbeddingJobStore["claim"]>[0]): Promise<EmbeddingJob[]> {
    required(input.org_id); required(input.generation); required(input.owner); timestamp(input.now);
    bounded(input.lease_ms, 1, 300000); bounded(input.limit, 1, 100);
    if (input.order !== undefined && input.order !== "oldest" && input.order !== "newest") {
      throw new Error("Invalid embedding job order");
    }
    const direction = input.order === "newest" ? "DESC" : "ASC";
    return this.db.transaction(() => {
      // A dead owner leaves the row running after its lease. Park it back in
      // its original queue position; staged chunks stay for the next claim.
      const expired = this.db.prepare(`SELECT id, started_at, lease_until, processing_ms FROM jobs
        WHERE org_id=? AND generation=? AND status='running' AND lease_until<=?
        ORDER BY lease_until`).all(
        input.org_id, input.generation, input.now,
      ) as Array<{ id: number; started_at: string | null; lease_until: string | null; processing_ms: number }>;
      const release = this.db.prepare(`UPDATE jobs SET status='pending',owner=NULL,lease_until=NULL,retry_at=NULL,
        processing_ms=?,started_at=NULL,completed_at=NULL WHERE id=?`);
      const nowMs = Date.parse(input.now);
      for (const row of expired) {
        const startedMs = Date.parse(row.started_at ?? input.now);
        const leaseMs = Date.parse(row.lease_until ?? input.now);
        const activeMs = Math.max(0, Math.min(leaseMs, nowMs) - startedMs);
        release.run(row.processing_ms + activeMs, row.id);
      }
      // The queue is pending, ordered by id. A failure stays failed until its
      // backoff elapses; only those due rows are merged back by their original id.
      // Expired leases were already returned to pending above, so they keep their place.
      const filter = claimIdFilter(input);
      const pending = this.db.prepare(`SELECT * FROM jobs
        WHERE org_id=? AND generation=? AND status='pending'${filter.sql}
        ORDER BY id ${direction} LIMIT ?`).all(
        input.org_id, input.generation, ...filter.params, input.limit,
      ) as JobRow[];
      const dueFailed = this.db.prepare(`SELECT * FROM jobs
        WHERE org_id=? AND generation=? AND status='failed' AND retry_at<=?${filter.sql}`).all(
        input.org_id, input.generation, input.now, ...filter.params,
      ) as JobRow[];
      const rows = dueFailed.length === 0 ? pending : [...pending, ...dueFailed]
        .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0) * (direction === "DESC" ? -1 : 1))
        .slice(0, input.limit);
      const until = new Date(Date.parse(input.now) + input.lease_ms).toISOString();
      for (const row of rows) {
        const staleAttemptMs = row.started_at
          ? Math.max(0, Math.min(
              Date.parse(row.lease_until ?? input.now),
              Date.parse(input.now),
            ) - Date.parse(row.started_at))
          : 0;
        this.db.prepare(`UPDATE jobs SET status='running',owner=?,lease_until=?,attempts=attempts+1,error_code=NULL,
          processing_ms=processing_ms+?,started_at=?,completed_at=NULL WHERE id=?`)
          .run(input.owner, until, staleAttemptMs, input.now, row.id);
        row.status = "running";
        row.attempts += 1;
        row.error_code = null;
        row.started_at = input.now;
        row.completed_at = null;
        row.processing_ms += staleAttemptMs;
      }
      return rows.map(jobFromRow);
    }).immediate();
  }

  async renew(job: EmbeddingJob, owner: string, now: string, leaseMs: number): Promise<boolean> {
    required(owner); timestamp(now); bounded(leaseMs, 1, 300000);
    return this.db.prepare(`UPDATE jobs SET lease_until=? WHERE id=? AND org_id=? AND generation=?
      AND status='running' AND owner=? AND lease_until>? AND fence=?`)
      .run(new Date(Date.parse(now) + leaseMs).toISOString(), job.id, job.org_id, job.generation, owner, now, job.fence).changes === 1;
  }

  private ownsJob(job: EmbeddingJob, owner: string, now: string): boolean {
    required(owner); timestamp(now);
    return Boolean(this.db.prepare(`SELECT j.id FROM jobs j JOIN source_heads h
      ON h.org_id=j.org_id AND h.source=j.source AND h.external_id=j.external_id
      WHERE j.id=? AND j.org_id=? AND j.generation=? AND j.event_id=? AND j.content_hash=?
      AND j.source=? AND j.external_id=? AND j.fence=? AND j.status='running' AND j.owner=? AND j.lease_until>?
      AND h.event_id=j.event_id AND h.fence=j.fence`)
      .get(job.id, job.org_id, job.generation, job.event_id, job.content_hash,
        job.source, job.external_id, job.fence, owner, now));
  }

  async loadStagedChunks(job: EmbeddingJob, owner: string, now: string): Promise<ContextVectorChunk[]> {
    if (!this.ownsJob(job, owner, now)) throw new Error("Embedding checkpoint lease lost");
    const generation = this.manifest(job.org_id, job.generation);
    const rows = this.db.prepare("SELECT ordinal,start,end,text_hash,vector,origin_json FROM staged_chunks WHERE job_id=? ORDER BY ordinal")
      .all(job.id) as Array<{ ordinal: number; start: number; end: number; text_hash: string; vector: Buffer; origin_json: string | null }>;
    if (rows.length > generation.max_chunks_per_event) throw new ContextVectorUnavailableError("corrupt");
    let end = 0;
    return rows.map((row, ordinal) => {
      if (row.ordinal !== ordinal || row.start !== end || !Number.isSafeInteger(row.end) || row.end <= end ||
        !validHash(row.text_hash) || !Buffer.isBuffer(row.vector) || row.vector.length !== generation.model.dimensions * 4) {
        throw new ContextVectorUnavailableError("corrupt");
      }
      const vector = Array.from({ length: generation.model.dimensions }, (_, i) => row.vector.readFloatLE(i * 4));
      validateEmbeddingVector(vector, generation.model.dimensions);
      end = row.end;
      const origin = parseOrigin(row.origin_json, row.text_hash, row.end - row.start);
      return { ordinal, start: row.start, end: row.end, text_hash: row.text_hash, vector, ...(origin ? { origin } : {}) };
    });
  }

  async stageChunk(input: Parameters<EmbeddingJobStore["stageChunk"]>[0]): Promise<boolean> {
    const { job, owner, now, chunk } = input;
    const generation = this.manifest(job.org_id, job.generation);
    if (!Number.isSafeInteger(chunk.ordinal) || chunk.ordinal < 0 ||
      chunk.ordinal >= generation.max_chunks_per_event ||
      !Number.isSafeInteger(chunk.start) || !Number.isSafeInteger(chunk.end) ||
      chunk.start < 0 || chunk.end <= chunk.start || !validHash(chunk.text_hash)) {
      throw new Error("Invalid staged embedding chunk");
    }
    validateEmbeddingVector(chunk.vector, generation.model.dimensions);
    if (chunk.origin) parseOrigin(JSON.stringify(chunk.origin), chunk.text_hash, chunk.end - chunk.start);
    return this.immediate(() => {
      if (!this.ownsJob(job, owner, now)) return false;
      this.assertVisualPermission(job.org_id, [chunk]);
      const previous = this.db.prepare("SELECT ordinal,end FROM staged_chunks WHERE job_id=? ORDER BY ordinal DESC LIMIT 1")
        .get(job.id) as { ordinal: number; end: number } | undefined;
      if (chunk.ordinal !== (previous ? previous.ordinal + 1 : 0) || chunk.start !== (previous?.end ?? 0)) {
        throw new Error("Non-contiguous embedding checkpoint");
      }
      const bytes = Buffer.alloc(chunk.vector.length * 4);
      chunk.vector.forEach((value, i) => bytes.writeFloatLE(value, i * 4));
      this.db.prepare("INSERT INTO staged_chunks VALUES (?,?,?,?,?,?,?)")
        .run(job.id, chunk.ordinal, chunk.start, chunk.end, chunk.text_hash, bytes, chunk.origin ? JSON.stringify(chunk.origin) : null);
      return true;
    });
  }

  async noteSlowLane(job: EmbeddingJob, owner: string, now: string): Promise<boolean> {
    return this.immediate(() => {
      if (!this.ownsJob(job, owner, now)) return false;
      this.db.prepare("UPDATE jobs SET lane='slow' WHERE id=?").run(job.id);
      return true;
    });
  }

  async yieldJob(job: EmbeddingJob, owner: string, now: string): Promise<boolean> {
    const processingMs = Math.max(0, Date.parse(now) - Date.parse(job.started_at ?? now));
    return this.db.transaction(() => {
      if (!this.ownsJob(job, owner, now)) return false;
      this.db.prepare(`UPDATE jobs SET status='pending',owner=NULL,lease_until=NULL,retry_at=NULL,
        attempts=MAX(attempts-1,0),processing_ms=processing_ms+?,started_at=NULL,completed_at=NULL WHERE id=?`)
        .run(processingMs, job.id);
      return true;
    }).immediate();
  }

  async complete(input: Parameters<EmbeddingJobStore["complete"]>[0]): Promise<boolean> {
    return this.writeComplete(input);
  }

  async publish(inputs: Array<Parameters<EmbeddingJobStore["complete"]>[0]>): Promise<boolean[]> {
    return this.immediate(() => inputs.map((input) => this.writeComplete(input)));
  }

  private writeComplete(input: Parameters<EmbeddingJobStore["complete"]>[0]): boolean {
    const { job, owner, now, chunks } = input;
    required(owner); timestamp(now);
    const generation = this.manifest(job.org_id, job.generation);
    const noContent = input.no_content === true;
    if (noContent && (generation.extractor_version !== "stored-body-and-attachments-v2" || chunks.length !== 0)) {
      throw new Error("Invalid empty embedding publication");
    }
    if (!validHash(job.content_hash) || !Array.isArray(chunks) || (!noContent && chunks.length === 0) ||
      chunks.length > generation.max_chunks_per_event) throw new Error("Invalid embedding publication");
    let end = 0;
    for (const [ordinal, chunk] of chunks.entries()) {
      if (chunk.ordinal !== ordinal || !Number.isSafeInteger(chunk.start) || !Number.isSafeInteger(chunk.end) ||
        chunk.start !== end || chunk.end <= chunk.start || !validHash(chunk.text_hash)) throw new Error("Invalid embedding chunk");
      validateEmbeddingVector(chunk.vector, generation.model.dimensions);
      if (chunk.origin) parseOrigin(JSON.stringify(chunk.origin), chunk.text_hash, chunk.end - chunk.start);
      end = chunk.end;
    }
    return this.immediate(() => {
      if (!this.ownsJob(job, owner, now)) return false;
      const authorizationState = this.currentVectorAuthorizationState(
        job.org_id,
        job.generation,
      );
      const authorizedKey = authorizationState
        ? this.db.prepare(
          "SELECT event_id,content_hash,body_length FROM vector_authorized WHERE event_id=? AND content_hash=?",
        ).get(job.event_id, job.content_hash) as {
          event_id: string;
          content_hash: string;
          body_length: number | null;
        } | undefined
        : undefined;
      let nativeChunkCount = authorizationState?.native_chunk_count ?? 0;
      if (authorizedKey) {
        nativeChunkCount -= this.removeNativeAuthorizedEvent(
          job.org_id,
          job.generation,
          job.event_id,
        );
        this.db.prepare("DELETE FROM vector_uncovered WHERE event_id=?").run(job.event_id);
        this.db.prepare("DELETE FROM vector_skipped WHERE event_id=?").run(job.event_id);
      }
      this.assertVisualPermission(job.org_id, chunks);
      this.db.prepare("DELETE FROM coverage WHERE org_id=? AND generation=? AND event_id=?")
        .run(job.org_id, job.generation, job.event_id);
      if (!noContent) {
        this.db.prepare("INSERT INTO coverage VALUES (?,?,?,?,?,?,?)")
          .run(job.org_id, job.generation, job.event_id, job.content_hash, job.source, job.external_id, chunks.length);
      }
      for (const chunk of chunks) {
        const bytes = Buffer.alloc(chunk.vector.length * 4);
        chunk.vector.forEach((value, index) => bytes.writeFloatLE(value, index * 4));
        this.db.prepare("INSERT INTO chunks VALUES (?,?,?,?,?,?,?,?,?)")
          .run(job.org_id, job.generation, job.event_id, chunk.ordinal, chunk.start, chunk.end, chunk.text_hash, bytes,
            chunk.origin ? JSON.stringify(chunk.origin) : null);
      }
      const processingMs = Math.max(0, Date.parse(now) - Date.parse(job.started_at ?? now));
      this.db.prepare(`UPDATE jobs SET status=?,owner=NULL,lease_until=NULL,retry_at=NULL,error_code=NULL,
        processing_ms=processing_ms+?,started_at=NULL,completed_at=? WHERE id=?`)
        .run(noContent ? "skipped" : "succeeded", processingMs, now, job.id);
      this.db.prepare("DELETE FROM staged_chunks WHERE job_id=?").run(job.id);
      const projectionRevision = this.recordProjectionChange(
        job.org_id,
        job.generation,
        job.event_id,
      );
      if (authorizationState && authorizedKey) {
        nativeChunkCount += this.refreshAuthorizedEvent(
          job.org_id,
          job.generation,
          {
            event_id: authorizedKey.event_id,
            content_hash: authorizedKey.content_hash,
            ...(authorizedKey.body_length === null
              ? {}
              : { body_length: authorizedKey.body_length }),
          },
          generation.model.dimensions,
        );
        this.updateVectorAuthorizationCounts(nativeChunkCount, projectionRevision);
      }
      return true;
    });
  }

  async fail(input: Parameters<EmbeddingJobStore["fail"]>[0]): Promise<boolean> {
    const { job, owner, now } = input;
    required(owner); timestamp(now); timestamp(input.retry_at);
    if (!/^[a-z_]{1,64}$/.test(input.error_code)) throw new Error("Invalid embedding error code");
    const processingMs = Math.max(0, Date.parse(now) - Date.parse(input.job.started_at ?? now));
    return this.db.prepare(`UPDATE jobs SET status=?,retry_at=?,error_code=?,owner=NULL,lease_until=NULL,
      processing_ms=processing_ms+?,started_at=NULL,completed_at=?
      WHERE id=? AND org_id=? AND generation=? AND status='running' AND owner=? AND lease_until>? AND fence=?`)
      .run(input.retryable ? "failed" : "quarantined", input.retry_at, input.error_code,
        processingMs, now, job.id, job.org_id, job.generation, owner, now, job.fence).changes === 1;
  }

  async listJobs(orgId: string, generation: string): Promise<EmbeddingJob[]> {
    required(orgId); required(generation);
    return (this.db.prepare("SELECT * FROM jobs WHERE org_id=? AND generation=? ORDER BY id")
      .all(orgId, generation) as JobRow[]).map(jobFromRow);
  }

  async summarizeJobs(orgId: string, generation: string, now = new Date().toISOString()): Promise<EmbeddingJobSummary> {
    required(orgId); required(generation); timestamp(now);
    const counts: EmbeddingJobSummary["counts"] = {
      pending: 0, running: 0, succeeded: 0, skipped: 0,
      failed: 0, quarantined: 0, superseded: 0,
    };
    const statuses = this.db.prepare(`SELECT status,COUNT(*) AS count FROM jobs
      WHERE org_id=? AND generation=? GROUP BY status`).all(orgId, generation) as Array<{
      status: EmbeddingJob["status"]; count: number;
    }>;
    for (const row of statuses) counts[row.status] = row.count;

    const expiredRunning = (this.db.prepare(`SELECT COUNT(*) AS count FROM jobs
      WHERE org_id=? AND generation=? AND status='running' AND (lease_until IS NULL OR lease_until<=?)`)
      .get(orgId, generation, now) as { count: number }).count;
    counts.running -= expiredRunning;
    counts.pending += expiredRunning;
    const running = this.db.prepare(`SELECT started_at,processing_ms FROM jobs
      WHERE org_id=? AND generation=? AND status='running' AND lease_until>? AND started_at IS NOT NULL`).all(
      orgId, generation, now,
    ) as Array<{
      started_at: string; processing_ms: number;
    }>;
    const nowMs = Date.parse(now);
    const runningElapsedMs = running.reduce((longest, job) => {
      const startedAt = Date.parse(job.started_at);
      return Number.isFinite(startedAt)
        ? Math.max(longest, job.processing_ms + Math.max(0, nowMs - startedAt))
        : longest;
    }, 0);
    const recent = this.db.prepare(`SELECT AVG(processing_ms) AS recent_processing_ms FROM (
      SELECT processing_ms FROM jobs WHERE org_id=? AND generation=?
        AND status IN ('succeeded','skipped') AND operation<>'tombstone' AND completed_at IS NOT NULL
      ORDER BY completed_at DESC,id DESC LIMIT 20
    )`).get(orgId, generation) as { recent_processing_ms: number | null };

    const failures = this.db.prepare(`SELECT error_code,status,COUNT(*) AS count FROM jobs
      WHERE org_id=? AND generation=? AND status IN ('failed','quarantined')
      GROUP BY error_code,status`).all(orgId, generation) as Array<{
      error_code: string | null; status: "failed" | "quarantined"; count: number;
    }>;
    const byCode = new Map<string, EmbeddingJobSummary["failures"][number]>();
    for (const row of failures) {
      const code = row.error_code ?? "indexing_failed";
      const failure = byCode.get(code) ?? {
        error_code: code, failed: 0, quarantined: 0,
      };
      failure[row.status] += row.count;
      byCode.set(code, failure);
    }
    return {
      counts,
      failures: [...byCode.values()].sort((a, b) => a.error_code.localeCompare(b.error_code)),
      timing: {
        as_of: now,
        ...(running.length ? { running_elapsed_ms: runningElapsedMs } : {}),
        ...(recent.recent_processing_ms !== null
          ? { recent_processing_ms: Math.round(recent.recent_processing_ms) }
          : {}),
      },
    };
  }

  async retryQuarantined(orgId: string, generation: string, eventId: string): Promise<boolean> {
    required(orgId); required(generation); required(eventId);
    return this.db.prepare(`UPDATE jobs SET status='pending',retry_at=NULL,error_code=NULL
      WHERE org_id=? AND generation=? AND event_id=? AND status='quarantined'
      AND EXISTS (SELECT 1 FROM source_heads h WHERE h.org_id=jobs.org_id
        AND h.source=jobs.source AND h.external_id=jobs.external_id AND h.event_id=jobs.event_id AND h.fence=jobs.fence)`)
      .run(orgId, generation, eventId).changes === 1;
  }

  async retryFailed(orgId: string, generation: string, limit: number): Promise<number> {
    required(orgId); required(generation); bounded(limit, 1, 20);
    return this.db.prepare(`UPDATE jobs SET status='pending',retry_at=NULL,error_code=NULL
      WHERE id IN (
        SELECT j.id FROM jobs j WHERE j.org_id=? AND j.generation=?
        AND j.status IN ('failed','quarantined') AND j.operation<>'tombstone'
        AND EXISTS (SELECT 1 FROM source_heads h WHERE h.org_id=j.org_id
          AND h.source=j.source AND h.external_id=j.external_id AND h.event_id=j.event_id AND h.fence=j.fence)
        ORDER BY j.id LIMIT ?
      )`).run(orgId, generation, limit).changes;
  }

  async matchAuthorized(input: Parameters<ContextVectorIndex["matchAuthorized"]>[0]): ReturnType<ContextVectorIndex["matchAuthorized"]> {
    this.rankedScopeKey = undefined;
    this.rankedFilterKey = undefined;
    this.db.prepare("DELETE FROM vector_ranked_native_rows").run();
    this.db.prepare("DELETE FROM vector_ranked_scope").run();
    try {
      return await this.matchAuthorizedView(input);
    } catch (error) {
      if (error instanceof Database.SqliteError) throw new ContextVectorUnavailableError("unavailable");
      throw error;
    }
  }

  async matchAuthorizedText(input: Parameters<NonNullable<ContextVectorIndex["matchAuthorizedText"]>>[0]) {
    const generation = this.manifest(input.org_id, input.generation);
    // Reuse the same authorization/coverage/fence and corruption checks without inference.
    const vector = Array.from({ length: generation.model.dimensions }, (_, index) => index === 0 ? 1 : 0);
    const result = await this.matchAuthorized({ ...input, query_vector: vector });
    return {
      ...result,
      matched: result.matched.filter((hit) => hit.search_matches?.some((match) => match.lexical))
        .map((hit) => ({
          ...hit, score: -1,
          search_matches: hit.search_matches!.filter((match) => match.lexical).map((match) => ({ ...match, score: -1 })),
        })),
    };
  }

  private async matchAuthorizedView(input: Parameters<ContextVectorIndex["matchAuthorized"]>[0]): ReturnType<ContextVectorIndex["matchAuthorized"]> {
    const generation = this.manifest(input.org_id, input.generation);
    validateEmbeddingVector(input.query_vector, generation.model.dimensions);
    const queryNorm = Math.sqrt(input.query_vector.reduce((sum, value) => sum + value * value, 0));
    bounded(input.limit, 1, 1000);
    if (!Array.isArray(input.authorized)) throw new Error("Invalid vector authorization set");
    if (input.authorization_hash !== undefined && !validHash(input.authorization_hash)) {
      throw new Error("Invalid vector authorization hash");
    }
    if (
      input.authorization_accumulator !== undefined
      && !validHash(input.authorization_accumulator)
    ) {
      throw new Error("Invalid vector authorization accumulator");
    }
    const authorizationMaintenance = input.authorization_hash && this.nativeVectors
      ? await this.ensureAuthorizedKnn(input, generation.model.dimensions)
      : undefined;
    return this.db.transaction(() => {
      this.synchronizeProjectionChanges(
        input.org_id,
        input.generation,
        generation.model.dimensions,
      );
      let state = input.authorization_hash
        ? this.vectorAuthorizationState(input)
        : null;
      let authorizationUpdate: "rebuilt" | "reused" | "delta" =
        authorizationMaintenance ?? (state ? "reused" : "rebuilt");
      if (!state && input.authorization_hash && input.authorization_delta) {
        state = this.applyVectorAuthorizationDelta(
          input,
          generation.model.dimensions,
        );
        if (state) authorizationUpdate = "delta";
      }
      let uncovered: Array<{ event_id: string; content_hash: string }>;
      let coveredCount: number;
      let nativeAuthorizedChunks = 0;
      if (state) {
        uncovered = this.db.prepare(
          "SELECT event_id,content_hash FROM vector_uncovered ORDER BY event_id",
        ).all() as Array<{ event_id: string; content_hash: string }>;
        coveredCount = state.covered_count;
        nativeAuthorizedChunks = state.native_chunk_count;
        if (this.nativeVectors && nativeAuthorizedChunks === 0 && coveredCount > 0) {
          throw new ContextVectorUnavailableError("corrupt");
        }
      } else if (!input.authorization_hash) {
        this.fillJsAuthorization(input.authorized);
        uncovered = [];
        coveredCount = 0;
      } else {
        const seen = new Set<string>();
        for (const key of input.authorized) {
          validateAuthorizationKey(key);
          if (seen.has(key.event_id)) throw new Error("Invalid vector authorization key");
          seen.add(key.event_id);
        }
        const authorizationAccumulator = contextVectorAuthorizationAccumulator(input.authorized);
        if (
          input.authorization_hash !== contextVectorAuthorizationHashFromAccumulator(
            input.authorized.length,
            authorizationAccumulator,
          )
          || (
            input.authorization_accumulator !== undefined
            && input.authorization_accumulator !== authorizationAccumulator
          )
        ) {
          throw new Error("Invalid vector authorization hash or accumulator");
        }
        if (this.nativeVectors) throw new ContextVectorUnavailableError("corrupt");
        this.invalidateVectorAuthorization();
        const authorize = this.db.prepare(
          "INSERT INTO vector_authorized (event_id, content_hash, body_length) VALUES (?, ?, ?)",
        );
        for (const key of input.authorized) {
          authorize.run(key.event_id, key.content_hash, key.body_length ?? null);
        }
        uncovered = this.db.prepare(`
          SELECT a.event_id,a.content_hash
          FROM vector_authorized a
          LEFT JOIN coverage c
            ON c.org_id=? AND c.generation=?
            AND c.event_id=a.event_id AND c.content_hash=a.content_hash
          LEFT JOIN source_heads h
            ON h.org_id=c.org_id AND h.source=c.source
            AND h.external_id=c.external_id AND h.event_id=c.event_id
          WHERE c.event_id IS NULL OR h.event_id IS NULL
          ORDER BY a.event_id
        `).all(input.org_id, input.generation) as Array<{ event_id: string; content_hash: string }>;
        coveredCount = input.authorized.length - uncovered.length;
        const saveUncovered = this.db.prepare(
          "INSERT INTO vector_uncovered (event_id,content_hash) VALUES (?,?)",
        );
        for (const key of uncovered) saveUncovered.run(key.event_id, key.content_hash);
        this.stageVectorSkipped(input.org_id, input.generation);
        this.db.prepare(`INSERT INTO vector_authorization_state (
          singleton,org_id,generation,authorization_hash,authorization_accumulator,authorized_count,
          covered_count,native_chunk_count,projection_revision
        ) VALUES (1,?,?,?,?,?,?,?,?)`).run(
          input.org_id,
          input.generation,
          input.authorization_hash,
          authorizationAccumulator,
          input.authorized.length,
          coveredCount,
          nativeAuthorizedChunks,
          this.projectionRevision(input.org_id, input.generation),
        );
      }
      const authorizationTable = input.authorization_hash
        ? "vector_authorized"
        : "vector_js_authorized";
      const accelerated = input.authorization_hash && nativeAuthorizedChunks > 0
        ? this.nativeAuthorizedRows(input)
        : undefined;
      const rows = accelerated?.rows ?? this.db.prepare(`
        SELECT c.event_id, c.content_hash, a.body_length, c.chunk_count,
               ch.ordinal, ch.start, ch.end, ch.vector, ch.origin_json, ch.text_hash
        FROM ${authorizationTable} a
        JOIN coverage c
          ON c.event_id=a.event_id AND c.content_hash=a.content_hash
        JOIN source_heads h
          ON h.org_id=c.org_id AND h.source=c.source
          AND h.external_id=c.external_id AND h.event_id=c.event_id
        LEFT JOIN chunks ch
          ON ch.org_id=c.org_id AND ch.generation=c.generation AND ch.event_id=c.event_id
        WHERE c.org_id=? AND c.generation=?
        ORDER BY c.event_id, ch.ordinal
      `).all(
        input.org_id,
        input.generation,
      ) as AuthorizedChunkRow[];
      const covered: Array<{ event_id: string; content_hash: string }> = [];
      const matched: ContextVectorMatch[] = [];
      const rank = (a: ContextVectorMatch, b: ContextVectorMatch) =>
        Number(Boolean(b.search_matches?.some((match) => match.lexical))) -
          Number(Boolean(a.search_matches?.some((match) => match.lexical))) ||
        b.score - a.score || compare(a.event_id, b.event_id);
      for (let offset = 0; offset < rows.length;) {
        const first = rows[offset];
        let best: { score: number; chunk_ordinal: number; start: number; end: number } | undefined;
        const parts = new Map<number, NonNullable<ContextVectorMatch["search_matches"]>[number]>();
        let textRun: { origin: ContextChunkOrigin; texts: string[]; end: number; score: number } | undefined;
        const admitPart = (origin: ContextChunkOrigin, score: number, lexical = false) => {
          if (!input.query || input.search_kind === "messages") return;
          const previous = parts.get(origin.part_index);
          if (!previous || (lexical && !previous.lexical) || (lexical === previous.lexical && score > previous.score)) {
            parts.set(origin.part_index, { origin, score, lexical });
          }
        };
        const flushTextRun = () => {
          if (!textRun) return;
          const origin = { ...textRun.origin, text: textRun.texts.join("") };
          if (scoreContextLexicalText(origin.text, input.query).lexical > 0) {
            admitPart(origin, textRun.score, true);
          }
          textRun = undefined;
        };
        let chunks = 0;
        let materialLength = 0;
        while (offset < rows.length && rows[offset].event_id === first.event_id) {
          const chunk = rows[offset];
          if (
            chunk.content_hash !== first.content_hash
            || chunk.chunk_count !== first.chunk_count
            || !Number.isSafeInteger(chunk.ordinal)
            || !Number.isSafeInteger(chunk.start)
            || !Number.isSafeInteger(chunk.end)
            || !Buffer.isBuffer(chunk.vector)
            || chunk.ordinal !== chunks || chunk.start !== materialLength || chunk.end! <= materialLength
          ) {
            throw new ContextVectorUnavailableError("corrupt");
          }
          const score = cosineScore(
            chunk.vector,
            input.query_vector,
            queryNorm,
            generation.model.dimensions,
          );
          const origin = parseOrigin(chunk.origin_json, chunk.text_hash, chunk.end! - chunk.start!);
          if (input.query && input.search_kind !== "messages") {
            // Token boundaries belong to continuous file text, not embedding chunks.
            if (origin?.mode === "text") {
              admitPart(origin, score);
              if (textRun && (textRun.origin.part_index !== origin.part_index ||
                textRun.origin.content_hash !== origin.content_hash || textRun.end !== origin.start)) {
                flushTextRun();
              }
              if (!textRun) {
                textRun = { origin, texts: [], end: origin.start, score };
              }
              textRun.texts.push(origin.text!);
              textRun.end = origin.start + origin.text!.length;
              textRun.score = Math.max(textRun.score, score);
            } else {
              flushTextRun();
              if (origin) admitPart(origin, score);
            }
          }
          const eligibleChunk = input.search_kind === "files" ? Boolean(origin)
            : input.search_kind === "messages"
              ? !origin && (first.body_length === null || chunk.end! <= first.body_length)
            : true;
          if (eligibleChunk && (!best || score > best.score)) {
            best = {
              score,
              chunk_ordinal: chunk.ordinal!,
              start: chunk.start!,
              end: chunk.end!,
            };
          }
          chunks += 1;
          materialLength = chunk.end!;
          offset += 1;
        }
        flushTextRun();
        if (chunks !== first.chunk_count || chunks === 0) {
          throw new ContextVectorUnavailableError("corrupt");
        }
        const key = { event_id: first.event_id, content_hash: first.content_hash };
        if (!input.authorization_hash) covered.push(key);
        if (!best) continue;
        matched.push({
          ...key, ...best,
          ...(parts.size ? { search_matches: [...parts.values()] } : {}),
          ...(generation.extractor_version === "stored-body-and-attachments-v2"
            ? { material_length: materialLength } : {}),
        });
        if (matched.length >= input.limit * 2) {
          matched.sort(rank);
          matched.length = input.limit;
        }
      }

      function cosineScore(
        vector: Buffer,
        query: number[],
        queryNorm: number,
        dimensions: number,
      ): number {
        if (vector.byteLength !== dimensions * 4) {
          throw new ContextVectorUnavailableError("corrupt");
        }
        let dot = 0;
        let squaredNorm = 0;
        for (let index = 0; index < dimensions; index += 1) {
          const value = vector.readFloatLE(index * 4);
          if (!Number.isFinite(value)) {
            throw new ContextVectorUnavailableError("corrupt");
          }
          dot += value * query[index];
          squaredNorm += value * value;
        }
        const vectorNorm = Math.sqrt(squaredNorm);
        if (!Number.isFinite(vectorNorm) || Math.abs(vectorNorm - 1) > 0.001) {
          throw new ContextVectorUnavailableError("corrupt");
        }
        const cosine = dot / (queryNorm * vectorNorm);
        return Number(Math.max(-1, Math.min(1, cosine)).toFixed(9));
      }
      matched.sort(rank);
      const meta = this.db.prepare("SELECT reconciled_epoch FROM generations WHERE org_id=? AND generation=?")
        .get(input.org_id, input.generation) as { reconciled_epoch: string | null };
      const skipped = input.authorization_hash
        ? this.db.prepare(
          "SELECT event_id,content_hash FROM vector_skipped ORDER BY event_id",
        ).all() as Array<{ event_id: string; content_hash: string }>
        : this.db.prepare(`SELECT j.event_id,j.content_hash FROM ${authorizationTable} a
          JOIN jobs j ON j.event_id=a.event_id AND j.content_hash=a.content_hash
          JOIN source_heads h ON h.org_id=j.org_id AND h.source=j.source
            AND h.external_id=j.external_id AND h.event_id=j.event_id AND h.fence=j.fence
          WHERE j.org_id=? AND j.generation=? AND j.status='skipped' ORDER BY j.event_id`)
          .all(input.org_id, input.generation) as Array<{ event_id: string; content_hash: string }>;
      return {
        generation: input.generation,
        covered: input.authorization_hash ? [] : covered.sort((a, b) => compare(a.event_id, b.event_id)),
        ...(input.authorization_hash ? {
          coverage: {
            authorization_hash: input.authorization_hash,
            authorized_count: input.authorized.length,
            covered_count: coveredCount,
            complete: uncovered.length === 0,
            uncovered,
          },
        } : {}),
        matched: matched.slice(0, input.limit),
        ...(accelerated && accelerated.candidateChunks > 0 ? {
          acceleration: {
            algorithm_version: "sqlite-vec-authorized-exact-v1" as const,
            authorized_chunks: nativeAuthorizedChunks,
            candidate_chunks: accelerated.candidateChunks,
            authorization_update: authorizationUpdate,
            ...(authorizationUpdate === "delta" ? {
              added_events: input.authorization_delta!.added.length,
              removed_events: input.authorization_delta!.removed.length,
            } : {}),
          },
        } : {}),
        ...(skipped.length ? { skipped } : {}),
        ...(meta.reconciled_epoch ? { reconciled_epoch: meta.reconciled_epoch } : {}),
      };
    })();
  }

  async clearOrganization(orgId: string): Promise<void> {
    required(orgId);
    this.db.transaction(() => {
      this.invalidateVectorAuthorization();
      this.db.prepare("DELETE FROM generations WHERE org_id=?").run(orgId);
      this.db.prepare("DELETE FROM source_heads WHERE org_id=?").run(orgId);
      this.db.prepare("DELETE FROM retired_generations WHERE org_id=?").run(orgId);
    }).immediate();
    this.db.pragma("wal_checkpoint(TRUNCATE)");
  }

  private vectorAuthorizationState(
    input: Parameters<ContextVectorIndex["matchAuthorized"]>[0],
  ): VectorAuthorizationStateRow | null {
    const state = this.db.prepare(`SELECT org_id,generation,authorization_hash,authorization_accumulator,
      authorized_count,covered_count,native_chunk_count,projection_revision
      FROM vector_authorization_state WHERE singleton=1`)
      .get() as VectorAuthorizationStateRow | undefined;
    return state
      && state.org_id === input.org_id
      && state.generation === input.generation
      && state.authorization_hash === input.authorization_hash
      && state.authorized_count === input.authorized.length
      ? state
      : null;
  }

  private currentVectorAuthorizationState(
    orgId: string,
    generation: string,
  ): VectorAuthorizationStateRow | null {
    const state = this.db.prepare(`SELECT org_id,generation,authorization_hash,authorization_accumulator,
      authorized_count,covered_count,native_chunk_count,projection_revision
      FROM vector_authorization_state WHERE singleton=1`)
      .get() as VectorAuthorizationStateRow | undefined;
    return state?.org_id === orgId && state.generation === generation ? state : null;
  }

  private updateVectorAuthorizationCounts(
    nativeChunkCount: number,
    projectionRevision?: number,
  ): void {
    if (!Number.isSafeInteger(nativeChunkCount) || nativeChunkCount < 0) {
      throw new ContextVectorUnavailableError("corrupt");
    }
    const authorizedCount = this.db.prepare("SELECT count(*) FROM vector_authorized")
      .pluck().get() as number;
    const uncoveredCount = this.db.prepare("SELECT count(*) FROM vector_uncovered")
      .pluck().get() as number;
    const revision = projectionRevision
      ?? this.db.prepare(
        "SELECT projection_revision FROM vector_authorization_state WHERE singleton=1",
      ).pluck().get() as number | undefined;
    if (!Number.isSafeInteger(revision) || revision === undefined || revision < 0) {
      throw new ContextVectorUnavailableError("corrupt");
    }
    this.db.prepare(`UPDATE vector_authorization_state
      SET authorized_count=?,covered_count=?,native_chunk_count=?,projection_revision=?
      WHERE singleton=1`).run(
      authorizedCount,
      authorizedCount - uncoveredCount,
      nativeChunkCount,
      revision,
    );
  }

  private projectionRevision(orgId: string, generation: string): number {
    const revision = this.db.prepare(
      "SELECT revision FROM vector_projection_revisions WHERE org_id=? AND generation=?",
    ).pluck().get(orgId, generation);
    if (!Number.isSafeInteger(revision) || (revision as number) < 0) {
      throw new ContextVectorUnavailableError("corrupt");
    }
    return revision as number;
  }

  private recordProjectionChange(
    orgId: string,
    generation: string,
    eventId: string,
  ): number {
    const revision = this.projectionRevision(orgId, generation) + 1;
    this.db.prepare(`UPDATE vector_projection_revisions
      SET revision=? WHERE org_id=? AND generation=?`)
      .run(revision, orgId, generation);
    this.db.prepare(`INSERT INTO vector_projection_changes(org_id,generation,event_id,revision)
      VALUES (?,?,?,?)
      ON CONFLICT(org_id,generation,event_id) DO UPDATE SET revision=excluded.revision`)
      .run(orgId, generation, eventId, revision);
    return revision;
  }

  private recordProjectionChangesForOrganization(
    orgId: string,
    eventIds: readonly string[],
  ): Map<string, number> {
    const generations = this.db.prepare(
      "SELECT generation FROM generations WHERE org_id=? ORDER BY generation",
    ).pluck().all(orgId) as string[];
    const revisions = new Map<string, number>();
    for (const generation of generations) {
      let revision = this.projectionRevision(orgId, generation);
      for (const eventId of eventIds) {
        revision = this.recordProjectionChange(orgId, generation, eventId);
      }
      revisions.set(generation, revision);
    }
    return revisions;
  }

  private synchronizeProjectionChanges(
    orgId: string,
    generation: string,
    dimensions: number,
  ): void {
    const state = this.currentVectorAuthorizationState(orgId, generation);
    if (!state) return;
    const revision = this.projectionRevision(orgId, generation);
    if (revision === state.projection_revision) return;
    if (revision < state.projection_revision) {
      throw new ContextVectorUnavailableError("corrupt");
    }
    const eventIds = this.db.prepare(`SELECT event_id
      FROM vector_projection_changes
      WHERE org_id=? AND generation=? AND revision>?
      ORDER BY revision,event_id`).pluck()
      .all(orgId, generation, state.projection_revision) as string[];
    let nativeChunkCount = state.native_chunk_count;
    for (const eventId of eventIds) {
      const key = this.db.prepare(
        "SELECT event_id,content_hash,body_length FROM vector_authorized WHERE event_id=?",
      ).get(eventId) as {
        event_id: string;
        content_hash: string;
        body_length: number | null;
      } | undefined;
      if (!key) continue;
      nativeChunkCount -= this.removeNativeAuthorizedEvent(
        orgId,
        generation,
        eventId,
      );
      nativeChunkCount += this.refreshAuthorizedEvent(
        orgId,
        generation,
        {
          event_id: key.event_id,
          content_hash: key.content_hash,
          ...(key.body_length === null ? {} : { body_length: key.body_length }),
        },
        dimensions,
      );
    }
    this.updateVectorAuthorizationCounts(nativeChunkCount, revision);
  }

  private applyVectorAuthorizationDelta(
    input: Parameters<ContextVectorIndex["matchAuthorized"]>[0],
    dimensions: number,
  ): VectorAuthorizationStateRow | null {
    const delta = input.authorization_delta;
    if (!delta || !input.authorization_hash || !input.authorization_accumulator) return null;
    const state = this.db.prepare(`SELECT org_id,generation,authorization_hash,authorization_accumulator,
      authorized_count,covered_count,native_chunk_count,projection_revision
      FROM vector_authorization_state WHERE singleton=1`)
      .get() as VectorAuthorizationStateRow | undefined;
    if (
      !state
      || state.org_id !== input.org_id
      || state.generation !== input.generation
      || state.authorization_hash !== delta.previous_authorization_hash
      || state.authorization_accumulator !== delta.previous_accumulator
    ) {
      return null;
    }
    if (!Array.isArray(delta.added) || !Array.isArray(delta.removed)) {
      throw new Error("Invalid vector authorization delta");
    }
    if (delta.added.length + delta.removed.length > 10_000) return null;
    if (
      !validHash(delta.previous_authorization_hash)
      || !validHash(delta.previous_accumulator)
      || !validHash(delta.accumulator)
      || delta.accumulator !== input.authorization_accumulator
      || state.authorized_count - delta.removed.length + delta.added.length !== input.authorized.length
      || updateContextVectorAuthorizationAccumulator(
        state.authorization_accumulator,
        delta.added,
        delta.removed,
      ) !== delta.accumulator
      || contextVectorAuthorizationHashFromAccumulator(
        input.authorized.length,
        delta.accumulator,
      ) !== input.authorization_hash
    ) {
      throw new Error("Invalid vector authorization delta");
    }
    if (
      state.native_chunk_count > 0
      && (!this.nativeVectors || !this.nativeKnnPartitionsReady())
    ) {
      return null;
    }
    const removedIds = new Set<string>();
    for (const key of delta.removed) {
      validateAuthorizationKey(key);
      if (removedIds.has(key.event_id)) throw new Error("Invalid vector authorization delta");
      removedIds.add(key.event_id);
      const current = this.db.prepare(
        "SELECT content_hash,body_length FROM vector_authorized WHERE event_id=?",
      ).get(key.event_id) as { content_hash: string; body_length: number | null } | undefined;
      if (
        !current
        || current.content_hash !== key.content_hash
        || current.body_length !== (key.body_length ?? null)
      ) {
        throw new Error("Invalid vector authorization removal");
      }
    }
    const addedIds = new Set<string>();
    for (const key of delta.added) {
      validateAuthorizationKey(key);
      if (addedIds.has(key.event_id)) throw new Error("Invalid vector authorization delta");
      addedIds.add(key.event_id);
      if (!removedIds.has(key.event_id) && this.db.prepare(
        "SELECT 1 FROM vector_authorized WHERE event_id=?",
      ).get(key.event_id)) {
        throw new Error("Invalid duplicate vector authorization addition");
      }
    }

    let nativeChunkCount = state.native_chunk_count;
    for (const key of delta.removed) {
      nativeChunkCount -= this.removeNativeAuthorizedEvent(
        input.org_id,
        input.generation,
        key.event_id,
      );
      this.db.prepare("DELETE FROM vector_uncovered WHERE event_id=?").run(key.event_id);
      this.db.prepare("DELETE FROM vector_skipped WHERE event_id=?").run(key.event_id);
      this.db.prepare("DELETE FROM vector_authorized WHERE event_id=?").run(key.event_id);
    }
    const insert = this.db.prepare(
      "INSERT INTO vector_authorized(event_id,content_hash,body_length) VALUES (?,?,?)",
    );
    for (const key of delta.added) {
      insert.run(key.event_id, key.content_hash, key.body_length ?? null);
      nativeChunkCount += this.refreshAuthorizedEvent(
        input.org_id,
        input.generation,
        key,
        dimensions,
      );
    }
    const authorizedCount = this.db.prepare("SELECT count(*) FROM vector_authorized")
      .pluck().get() as number;
    if (authorizedCount !== input.authorized.length || nativeChunkCount < 0) {
      throw new ContextVectorUnavailableError("corrupt");
    }
    const uncoveredCount = this.db.prepare("SELECT count(*) FROM vector_uncovered")
      .pluck().get() as number;
    const coveredCount = authorizedCount - uncoveredCount;
    this.db.prepare(`UPDATE vector_authorization_state
      SET authorization_hash=?,authorization_accumulator=?,authorized_count=?,
          covered_count=?,native_chunk_count=?
      WHERE singleton=1`).run(
      input.authorization_hash,
      input.authorization_accumulator,
      authorizedCount,
      coveredCount,
      nativeChunkCount,
    );
    return {
      org_id: input.org_id,
      generation: input.generation,
      authorization_hash: input.authorization_hash,
      authorization_accumulator: input.authorization_accumulator,
      authorized_count: authorizedCount,
      covered_count: coveredCount,
      native_chunk_count: nativeChunkCount,
      projection_revision: state.projection_revision,
    };
  }

  private removeNativeAuthorizedEvent(
    orgId: string,
    generation: string,
    eventId: string,
  ): number {
    if (!this.nativeVectors || !this.nativeKnnPartitionsReady()) return 0;
    const rowids = this.db.prepare(
      "SELECT rowid FROM vector_authorized_native_rows WHERE event_id=?",
    ).pluck().all(eventId) as number[];
    const remove = NATIVE_KNN_PARTITIONS.map((partition) => this.db.prepare(
      `DELETE FROM ${partition} WHERE rowid=?`,
    ));
    const exists = NATIVE_KNN_PARTITIONS.map((partition) => this.db.prepare(
      `SELECT 1 FROM ${partition} WHERE rowid=?`,
    ));
    let removed = 0;
    for (const rowid of rowids) {
      let found = false;
      for (let index = 0; index < NATIVE_KNN_PARTITIONS.length; index += 1) {
        if (!exists[index].get(rowid)) continue;
        remove[index].run(rowid);
        found = true;
      }
      if (found) removed += 1;
    }
    this.db.prepare(
      "DELETE FROM vector_authorized_native_rows WHERE event_id=?",
    ).run(eventId);
    return removed;
  }

  private refreshAuthorizedEvent(
    orgId: string,
    generation: string,
    key: ContextVectorAuthorizationKey,
    dimensions: number,
  ): number {
    this.db.prepare("DELETE FROM vector_uncovered WHERE event_id=?").run(key.event_id);
    this.db.prepare("DELETE FROM vector_skipped WHERE event_id=?").run(key.event_id);
    const covered = this.db.prepare(`
      SELECT c.event_id
      FROM coverage c
      JOIN source_heads h
        ON h.org_id=c.org_id AND h.source=c.source
        AND h.external_id=c.external_id AND h.event_id=c.event_id
      WHERE c.org_id=? AND c.generation=?
        AND c.event_id=? AND c.content_hash=?
    `).get(orgId, generation, key.event_id, key.content_hash);
    if (!covered) {
      this.db.prepare(
        "INSERT INTO vector_uncovered(event_id,content_hash) VALUES (?,?)",
      ).run(key.event_id, key.content_hash);
      const skipped = this.db.prepare(`SELECT 1 FROM jobs j
        JOIN source_heads h ON h.org_id=j.org_id AND h.source=j.source
          AND h.external_id=j.external_id AND h.event_id=j.event_id AND h.fence=j.fence
        WHERE j.org_id=? AND j.generation=? AND j.event_id=?
          AND j.content_hash=? AND j.status='skipped'`)
        .get(orgId, generation, key.event_id, key.content_hash);
      if (skipped) {
        this.db.prepare(
          "INSERT INTO vector_skipped(event_id,content_hash) VALUES (?,?)",
        ).run(key.event_id, key.content_hash);
      }
      return 0;
    }
    if (!this.nativeVectors || !this.nativeKnnPartitionsReady()) return 0;
    const bodyLength = key.body_length ?? null;
    this.db.prepare(`
      INSERT INTO vector_authorized_knn_messages(rowid,embedding)
      SELECT rowid,vector FROM chunks
      WHERE org_id=? AND generation=? AND event_id=?
        AND origin_json IS NULL AND (? IS NULL OR "end" <= ?)
      ORDER BY rowid
    `).run(orgId, generation, key.event_id, bodyLength, bodyLength);
    this.db.prepare(`
      INSERT INTO vector_authorized_knn_files(rowid,embedding)
      SELECT rowid,vector FROM chunks
      WHERE org_id=? AND generation=? AND event_id=?
        AND origin_json IS NOT NULL
      ORDER BY rowid
    `).run(orgId, generation, key.event_id);
    this.db.prepare(`
      INSERT INTO vector_authorized_knn_rest(rowid,embedding)
      SELECT rowid,vector FROM chunks
      WHERE org_id=? AND generation=? AND event_id=?
        AND origin_json IS NULL AND ? IS NOT NULL AND "end" > ?
      ORDER BY rowid
    `).run(orgId, generation, key.event_id, bodyLength, bodyLength);
    this.db.prepare(`
      INSERT INTO vector_authorized_native_rows(event_id,rowid)
      SELECT event_id,rowid FROM chunks
      WHERE org_id=? AND generation=? AND event_id=?
      ORDER BY event_id,rowid
    `).run(orgId, generation, key.event_id);
    const count = this.db.prepare(
      "SELECT count(*) FROM chunks WHERE org_id=? AND generation=? AND event_id=?",
    ).pluck().get(orgId, generation, key.event_id) as number;
    if (count > 0) {
      const bytes = this.db.prepare(
        "SELECT length(vector) FROM chunks WHERE org_id=? AND generation=? AND event_id=? LIMIT 1",
      ).pluck().get(orgId, generation, key.event_id) as number;
      if (bytes !== dimensions * 4) throw new ContextVectorUnavailableError("corrupt");
    }
    return count;
  }

  private loadNativeVectors(): boolean {
    try {
      loadSqliteVec(this.db);
      return true;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      process.emitWarning(
        `sqlite-vec acceleration is unavailable; using exact JavaScript vector scan: ${detail}`,
        { code: "REGENIC_SQLITE_VEC_UNAVAILABLE" },
      );
      return false;
    }
  }

  async matchRanked(
    input: RankedHeadQuery & { generation: string; query_vector: number[]; limit: number },
  ): Promise<{
    matched: Array<{
      event_id: string;
      content_hash: string;
      score: number;
      chunk_ordinal: number;
      start: number;
      end: number;
    }>;
    authorized_count: number;
    covered_count: number;
  }> {
    const generation = this.manifest(input.org_id, input.generation);
    if (input.query_vector.length !== generation.model.dimensions) {
      throw new ContextVectorUnavailableError("unavailable");
    }
    await this.prepareRanked(input);
    const counts = this.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM vector_authorized) AS authorized_count,
        (SELECT COUNT(*)
          FROM vector_authorized a
          JOIN coverage c
            ON c.org_id = ? AND c.generation = ?
            AND c.event_id = a.event_id AND c.content_hash = a.content_hash) AS covered_count
    `).get(input.org_id, input.generation) as { authorized_count: number; covered_count: number };
    const authorizedChunks = this.rankedNativeChunkCount();
    if (!this.nativeVectors) throw new ContextVectorUnavailableError("unavailable");
    if (authorizedChunks < 1 || !Number.isSafeInteger(input.limit) || input.limit < 1) {
      return { matched: [], ...counts };
    }
    const query = vectorBuffer(input.query_vector);
    const statements = NATIVE_KNN_PARTITIONS.map((partition) => this.db.prepare(`
      SELECT ch.event_id, c.content_hash, ch.ordinal, ch.start, ch.end, ch.vector, v.distance
      FROM ${partition} v
      JOIN chunks ch ON ch.rowid = v.rowid
      JOIN coverage c
        ON c.org_id = ? AND c.generation = ? AND c.event_id = ch.event_id
      JOIN vector_authorized a ON a.event_id = c.event_id AND a.content_hash = c.content_hash
      WHERE v.embedding MATCH ? AND k = ?
      ORDER BY v.distance, ch.event_id
    `));
    let candidateLimit = Math.min(authorizedChunks, Math.max(input.limit * 4, 100));
    let rows: RankedVectorRow[] = [];
    let selected: string[] = [];
    while (candidateLimit > 0) {
      const merged: RankedVectorRow[] = [];
      for (let index = 0; index < NATIVE_KNN_PARTITIONS.length; index += 1) {
        const count = this.nativeKnnCount(NATIVE_KNN_PARTITIONS[index]);
        if (count < 1) continue;
        merged.push(...statements[index].all(
          input.org_id,
          input.generation,
          query,
          Math.min(candidateLimit, count),
        ) as RankedVectorRow[]);
      }
      merged.sort((left, right) => left.distance - right.distance || compare(left.event_id, right.event_id));
      rows = merged.slice(0, candidateLimit);
      const best = new Map<string, number>();
      for (const row of rows) {
        if (!Number.isFinite(row.distance) || row.distance < 0 || row.distance > 2) {
          throw new ContextVectorUnavailableError("corrupt");
        }
        const previous = best.get(row.event_id);
        if (previous === undefined || row.distance < previous) best.set(row.event_id, row.distance);
      }
      const ranked = [...best].sort((left, right) => left[1] - right[1] || compare(left[0], right[0]));
      selected = ranked.slice(0, input.limit).map(([eventId]) => eventId);
      const boundary = ranked[input.limit - 1]?.[1];
      const tail = rows.at(-1)?.distance;
      if (
        candidateLimit >= authorizedChunks
        || (selected.length === input.limit && boundary !== undefined && tail !== undefined && boundary < tail)
      ) break;
      candidateLimit = Math.min(authorizedChunks, candidateLimit * 2);
    }
    const wanted = new Set(selected);
    const queryNorm = input.query_vector.reduce((sum, value) => sum + value * value, 0);
    const bestChunk = new Map<string, RankedVectorRow & { score: number }>();
    for (const row of rows) {
      if (!wanted.has(row.event_id)) continue;
      const score = rankedCosine(row.vector, input.query_vector, Math.sqrt(queryNorm), generation.model.dimensions);
      const previous = bestChunk.get(row.event_id);
      if (!previous || score > previous.score) bestChunk.set(row.event_id, { ...row, score });
    }
    const matched = [...bestChunk.values()]
      .filter((row) => row.score >= -1 && row.score <= 1 && row.end > row.start)
      .sort((left, right) => right.score - left.score || compare(left.event_id, right.event_id))
      .slice(0, input.limit)
      .map((row) => ({
        event_id: row.event_id,
        content_hash: row.content_hash,
        score: row.score,
        chunk_ordinal: row.ordinal,
        start: row.start,
        end: row.end,
      }));
    return { matched, ...counts };
  }

  /**
   * Build the persistent ranked index for one authority filter. Startup and
   * search share one run, so a search does not copy the corpus again.
   */
  async prepareRanked(input: RankedHeadQuery & { generation: string }): Promise<void> {
    if (this.rankedWarm) {
      await this.rankedWarm;
      return this.prepareRanked(input);
    }
    let resolveWaiters: () => void = () => {};
    let rejectWaiters: (error: unknown) => void = () => {};
    const gate = new Promise<void>((resolve, reject) => {
      resolveWaiters = resolve;
      rejectWaiters = reject;
    });
    this.rankedWarm = gate;
    void gate.catch(() => {});
    try {
      await this.maintainRanked(input);
      resolveWaiters();
    } catch (error) {
      rejectWaiters(error);
      throw error;
    } finally {
      if (this.rankedWarm === gate) this.rankedWarm = null;
    }
  }

  private async maintainRanked(input: RankedHeadQuery & { generation: string }): Promise<void> {
    const generation = this.manifest(input.org_id, input.generation);
    const filterKey = authorizedHeadFilterKey(input.org_id, input.filters, input.generation);
    const scopeKey = authorizedHeadScopeKey(input.stamp, input.org_id, input.filters, input.generation);
    const where = authorizedHeadWhere(input.org_id, input.filters);
    const persisted = this.rankedScope();
    const reusable = Boolean(
      persisted
      && persisted.org_id === input.org_id
      && persisted.generation === input.generation
      && persisted.filter_key === filterKey
      && persisted.dimensions === generation.model.dimensions
      && this.nativeKnnPartitionsReady()
      && persisted.native_chunk_count === this.nativeAuthorizedChunkCount(),
    );
    if (!reusable) {
      const marker = this.readHeadMarker(input.authority_path, input.org_id);
      await this.replaceRankedAuthorized(where, input.authority_path, input.org_id);
      const indexed = await this.stageRankedNative(generation.model.dimensions, input.org_id, input.generation);
      this.saveRankedScope(
        input.org_id, input.generation, filterKey, scopeKey, generation.model.dimensions, indexed, marker,
      );
    } else if (persisted!.scope_key !== scopeKey) {
      const marker = this.readHeadMarker(input.authority_path, input.org_id);
      if (!this.headMarkerMatches(persisted!, marker)) {
        await this.syncRankedAuthorized(
          where,
          input.authority_path,
          input.org_id,
          input.generation,
          generation.model.dimensions,
          persisted!.head_sequence,
        );
      }
      this.saveRankedScope(
        input.org_id,
        input.generation,
        filterKey,
        scopeKey,
        generation.model.dimensions,
        this.nativeAuthorizedChunkCount(),
        marker,
      );
    }
    this.rankedFilterKey = filterKey;
    this.rankedScopeKey = scopeKey;
  }

  private async stageRankedNative(dimensions: number, orgId: string, generation: string): Promise<number> {
    if (!this.nativeVectors) return 0;
    this.db.prepare("DELETE FROM vector_authorization_state").run();
    this.db.prepare("DELETE FROM vector_ranked_scope").run();
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM vector_authorized_native_rows").run();
      this.db.prepare("DELETE FROM vector_ranked_native_rows").run();
      for (const partition of NATIVE_KNN_PARTITIONS) this.createNativeKnnTable(partition, dimensions);
      this.db.prepare(`
        INSERT INTO vector_knn_meta(singleton, dimensions) VALUES (1, ?)
        ON CONFLICT(singleton) DO UPDATE SET dimensions=excluded.dimensions
      `).run(dimensions);
    }).immediate();
    await this.backfillAuthorizedKnn(orgId, generation);
    this.db.prepare(`
      INSERT INTO vector_ranked_native_rows (event_id, content_hash, rowid)
      SELECT n.event_id, a.content_hash, n.rowid
      FROM vector_authorized_native_rows n
      JOIN vector_authorized a ON a.event_id = n.event_id
    `).run();
    return this.nativeAuthorizedChunkCount();
  }

  /**
   * A connection stamp moves on every authority write. Head cardinality and the
   * event-log sequence move only when a head can have changed, so an unrelated
   * commit does not reread blobs.
   */
  private headMarkerMatches(
    saved: { head_sequence: number | null; head_count: number | null },
    marker: { sequence: number | null; count: number },
  ): boolean {
    return saved.head_count != null
      && saved.head_count === marker.count
      && saved.head_sequence === marker.sequence;
  }

  private readHeadMarker(authorityPath: string, orgId: string): { sequence: number | null; count: number } {
    return withAttachedAuthority(this.db, authorityPath, () => {
      const hasSequence = this.db.prepare(
        "SELECT 1 FROM pragma_table_info('events', 'regenic_auth') WHERE name = 'sequence'",
      ).get();
      const sequence = hasSequence
        ? this.db.prepare("SELECT MAX(sequence) FROM regenic_auth.events").pluck().get() as number | null
        : null;
      const count = this.db.prepare(
        "SELECT COUNT(*) FROM regenic_auth.source_heads WHERE org_id = ?",
      ).pluck().get(orgId) as number;
      return { sequence: sequence ?? null, count };
    });
  }

  /** First build. Pages head identities, then applies the searchable predicate to that page only. */
  private async replaceRankedAuthorized(
    where: { sql: string; params: unknown[] },
    authorityPath: string,
    orgId: string,
  ): Promise<void> {
    this.db.prepare("DELETE FROM vector_authorized").run();
    let source = "";
    let externalId = "";
    const pageSize = 512;
    for (;;) {
      const done = withAttachedAuthority(this.db, authorityPath, () => {
        this.db.prepare("DELETE FROM vector_head_tail").run();
        const rows = this.db.prepare(authorityHeadPageSql()).all(
          orgId, source, externalId, pageSize,
        ) as Array<{ source: string; external_id: string; event_id: string }>;
        if (rows.length === 0) return true;
        const insertId = this.db.prepare("INSERT OR IGNORE INTO vector_head_tail(event_id) VALUES (?)");
        for (const row of rows) insertId.run(row.event_id);
        this.db.prepare(`
          INSERT OR IGNORE INTO vector_authorized (event_id, content_hash, body_length)
          SELECT DISTINCT e.id, e.content_hash, NULL
          ${authorityHeadQualifyFrom(where.sql, "vector_head_tail")}
        `).run(...where.params);
        const last = rows[rows.length - 1]!;
        if (last.source === source && last.external_id === externalId) {
          throw new Error("vector head cursor did not advance");
        }
        source = last.source;
        externalId = last.external_id;
        return rows.length < pageSize;
      });
      if (done) return;
      await this.yieldEventLoop();
    }
  }

  /** Apply head deletions and the event-log tail. Does not reread heads that are already classified. */
  private async syncRankedAuthorized(
    where: { sql: string; params: unknown[] },
    authorityPath: string,
    orgId: string,
    generation: string,
    dimensions: number,
    previousSequence: number | null,
  ): Promise<void> {
    const added = withAttachedAuthority(this.db, authorityPath, () => {
      const removed = this.db.prepare(`
        SELECT a.event_id FROM vector_authorized a
        WHERE NOT EXISTS (
          SELECT 1 FROM regenic_auth.source_heads h
          WHERE h.org_id = ? AND h.current_event_id = a.event_id
        )
      `).pluck().all(orgId) as string[];
      for (const eventId of removed) {
        this.removeNativeAuthorizedEvent(orgId, generation, eventId);
        this.db.prepare("DELETE FROM vector_ranked_native_rows WHERE event_id=?").run(eventId);
        this.db.prepare("DELETE FROM vector_authorized WHERE event_id=?").run(eventId);
      }
      this.db.prepare("DELETE FROM vector_head_tail").run();
      if (previousSequence == null) {
        this.db.prepare(`
          INSERT INTO vector_head_tail(event_id)
          SELECT DISTINCT h.current_event_id
          FROM regenic_auth.source_heads h
          WHERE h.org_id = ?
            AND NOT EXISTS (
              SELECT 1 FROM vector_authorized a WHERE a.event_id = h.current_event_id
            )
        `).run(orgId);
      } else {
        this.db.prepare(`
          INSERT INTO vector_head_tail(event_id)
          ${authorityEventsAfterSql()}
        `).run(orgId, previousSequence);
      }
      return this.db.prepare(`
        SELECT DISTINCT e.id AS event_id, e.content_hash AS content_hash
        ${authorityHeadQualifyFrom(where.sql, "vector_head_tail")}
      `).all(...where.params) as Array<{ event_id: string; content_hash: string }>;
    });
    for (const key of added) {
      const current = this.db.prepare(
        "SELECT content_hash FROM vector_authorized WHERE event_id=?",
      ).get(key.event_id) as { content_hash: string } | undefined;
      if (current?.content_hash === key.content_hash) continue;
      if (current) this.removeNativeAuthorizedEvent(orgId, generation, key.event_id);
      this.db.prepare(`
        INSERT INTO vector_authorized (event_id, content_hash, body_length) VALUES (?, ?, NULL)
        ON CONFLICT(event_id) DO UPDATE SET
          content_hash = excluded.content_hash,
          body_length = NULL
      `).run(key.event_id, key.content_hash);
      this.refreshAuthorizedEvent(orgId, generation, {
        event_id: key.event_id,
        content_hash: key.content_hash,
      }, dimensions);
    }
  }

  private rankedScope(): {
    org_id: string;
    generation: string;
    filter_key: string;
    scope_key: string;
    dimensions: number;
    native_chunk_count: number;
    head_sequence: number | null;
    head_count: number | null;
  } | undefined {
    return this.db.prepare(`
      SELECT org_id, generation, filter_key, scope_key, dimensions, native_chunk_count,
        head_sequence, head_count
      FROM vector_ranked_scope WHERE singleton=1
    `).get() as {
      org_id: string;
      generation: string;
      filter_key: string;
      scope_key: string;
      dimensions: number;
      native_chunk_count: number;
      head_sequence: number | null;
      head_count: number | null;
    } | undefined;
  }

  private saveRankedScope(
    orgId: string,
    generation: string,
    filterKey: string,
    scopeKey: string,
    dimensions: number,
    nativeChunkCount: number,
    marker: { sequence: number | null; count: number },
  ): void {
    this.db.prepare(`
      INSERT INTO vector_ranked_scope(
        singleton, org_id, generation, filter_key, scope_key, dimensions, native_chunk_count,
        head_sequence, head_count
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(singleton) DO UPDATE SET
        org_id=excluded.org_id,
        generation=excluded.generation,
        filter_key=excluded.filter_key,
        scope_key=excluded.scope_key,
        dimensions=excluded.dimensions,
        native_chunk_count=excluded.native_chunk_count,
        head_sequence=excluded.head_sequence,
        head_count=excluded.head_count
    `).run(
      orgId, generation, filterKey, scopeKey, dimensions, nativeChunkCount,
      marker.sequence, marker.count,
    );
  }

  private fillJsAuthorization(authorized: ContextVectorAuthorizationKey[]): void {
    this.db.exec(`
      CREATE TEMP TABLE IF NOT EXISTS vector_js_authorized (
        event_id TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        body_length INTEGER
      ) WITHOUT ROWID;
      DELETE FROM vector_js_authorized;
    `);
    const insert = this.db.prepare(
      "INSERT INTO vector_js_authorized (event_id, content_hash, body_length) VALUES (?, ?, ?)",
    );
    const seen = new Set<string>();
    for (const key of authorized) {
      validateAuthorizationKey(key);
      if (seen.has(key.event_id)) throw new Error("Invalid vector authorization key");
      seen.add(key.event_id);
      insert.run(key.event_id, key.content_hash, key.body_length ?? null);
    }
  }

  private static readonly knnBackfillBatch = 1024;

  private yieldEventLoop(): Promise<void> {
    return new Promise((resolve) => { setImmediate(resolve); });
  }

  private authorizedKnnReady(
    input: Parameters<ContextVectorIndex["matchAuthorized"]>[0],
    dimensions: number,
  ): boolean {
    if (!this.nativeVectors || !this.nativeKnnPartitionsReady()) return false;
    if (this.knnDimensions() !== dimensions) return false;
    const state = this.vectorAuthorizationState(input);
    if (!state) return false;
    return state.native_chunk_count === this.nativeAuthorizedChunkCount();
  }

  private async ensureAuthorizedKnn(
    input: Parameters<ContextVectorIndex["matchAuthorized"]>[0],
    dimensions: number,
  ): Promise<"rebuilt" | "reused" | "delta"> {
    if (this.authorizedKnnReady(input, dimensions)) return "reused";
    if (this.knnMaintenance) {
      await this.knnMaintenance;
      return this.ensureAuthorizedKnn(input, dimensions);
    }
    let kind: "rebuilt" | "delta" = "rebuilt";
    const work = (async () => {
      kind = await this.maintainAuthorizedKnn(input, dimensions);
    })();
    this.knnMaintenance = work;
    try {
      await work;
    } finally {
      if (this.knnMaintenance === work) this.knnMaintenance = null;
    }
    if (!this.authorizedKnnReady(input, dimensions)) return this.ensureAuthorizedKnn(input, dimensions);
    return kind;
  }

  private async maintainAuthorizedKnn(
    input: Parameters<ContextVectorIndex["matchAuthorized"]>[0],
    dimensions: number,
  ): Promise<"rebuilt" | "delta"> {
    if (this.tryApplyAuthorizationDelta(input, dimensions)) return "delta";
    await this.rebuildAuthorizedKnn(input, dimensions);
    return "rebuilt";
  }

  private tryApplyAuthorizationDelta(
    input: Parameters<ContextVectorIndex["matchAuthorized"]>[0],
    dimensions: number,
  ): boolean {
    if (!input.authorization_delta || !this.nativeKnnPartitionsReady()) return false;
    if (this.knnDimensions() !== dimensions) return false;
    const state = this.db.transaction(() => this.applyVectorAuthorizationDelta(input, dimensions))();
    return state !== null;
  }

  private async rebuildAuthorizedKnn(
    input: Parameters<ContextVectorIndex["matchAuthorized"]>[0],
    dimensions: number,
  ): Promise<void> {
    const seen = new Set<string>();
    for (const key of input.authorized) {
      validateAuthorizationKey(key);
      if (seen.has(key.event_id)) throw new Error("Invalid vector authorization key");
      seen.add(key.event_id);
    }
    const authorizationAccumulator = contextVectorAuthorizationAccumulator(input.authorized);
    if (
      input.authorization_hash !== contextVectorAuthorizationHashFromAccumulator(
        input.authorized.length,
        authorizationAccumulator,
      )
      || (
        input.authorization_accumulator !== undefined
        && input.authorization_accumulator !== authorizationAccumulator
      )
    ) {
      throw new Error("Invalid vector authorization hash or accumulator");
    }
    const projectionRevision = this.projectionRevision(input.org_id, input.generation);
    this.db.transaction(() => {
      this.invalidateVectorAuthorization();
    }).immediate();
    const authorize = this.db.prepare(
      "INSERT INTO vector_authorized (event_id, content_hash, body_length) VALUES (?, ?, ?)",
    );
    for (let offset = 0; offset < input.authorized.length; offset += SqliteContextVectorIndex.knnBackfillBatch) {
      const batch = input.authorized.slice(offset, offset + SqliteContextVectorIndex.knnBackfillBatch);
      this.db.transaction(() => {
        for (const key of batch) authorize.run(key.event_id, key.content_hash, key.body_length ?? null);
      })();
      await this.yieldEventLoop();
    }
    const uncovered = this.db.prepare(`
      SELECT a.event_id,a.content_hash
      FROM vector_authorized a
      LEFT JOIN coverage c
        ON c.org_id=? AND c.generation=?
        AND c.event_id=a.event_id AND c.content_hash=a.content_hash
      LEFT JOIN source_heads h
        ON h.org_id=c.org_id AND h.source=c.source
        AND h.external_id=c.external_id AND h.event_id=c.event_id
      WHERE c.event_id IS NULL OR h.event_id IS NULL
      ORDER BY a.event_id
    `).all(input.org_id, input.generation) as Array<{ event_id: string; content_hash: string }>;
    this.db.transaction(() => {
      const saveUncovered = this.db.prepare(
        "INSERT INTO vector_uncovered (event_id,content_hash) VALUES (?,?)",
      );
      for (const key of uncovered) saveUncovered.run(key.event_id, key.content_hash);
      this.stageVectorSkipped(input.org_id, input.generation);
      for (const partition of NATIVE_KNN_PARTITIONS) this.createNativeKnnTable(partition, dimensions);
      this.db.prepare(`
        INSERT INTO vector_knn_meta(singleton, dimensions) VALUES (1, ?)
        ON CONFLICT(singleton) DO UPDATE SET dimensions=excluded.dimensions
      `).run(dimensions);
    }).immediate();
    const coveredCount = input.authorized.length - uncovered.length;
    if (coveredCount > 0) await this.backfillAuthorizedKnn(input.org_id, input.generation);
    const nativeChunkCount = this.nativeAuthorizedChunkCount();
    this.db.prepare(`INSERT INTO vector_authorization_state (
      singleton,org_id,generation,authorization_hash,authorization_accumulator,authorized_count,
      covered_count,native_chunk_count,projection_revision
    ) VALUES (1,?,?,?,?,?,?,?,?)`).run(
      input.org_id,
      input.generation,
      input.authorization_hash,
      authorizationAccumulator,
      input.authorized.length,
      coveredCount,
      nativeChunkCount,
      projectionRevision,
    );
  }

  private async backfillAuthorizedKnn(orgId: string, generation: string): Promise<void> {
    const batch = SqliteContextVectorIndex.knnBackfillBatch;
    const coveredChunks = `
      FROM chunks ch
      JOIN coverage c
        ON c.org_id=ch.org_id AND c.generation=ch.generation AND c.event_id=ch.event_id
      JOIN source_heads h
        ON h.org_id=c.org_id AND h.source=c.source
        AND h.external_id=c.external_id AND h.event_id=c.event_id
      JOIN vector_authorized a
        ON a.event_id=c.event_id AND a.content_hash=c.content_hash
      WHERE ch.org_id=? AND ch.generation=?
    `;
    const fillFirst = this.db.prepare(`
      INSERT INTO vector_knn_backfill_batch(event_id, ordinal, chunk_rowid)
      SELECT ch.event_id, ch.ordinal, ch.rowid
      ${coveredChunks}
      ORDER BY ch.event_id, ch.ordinal
      LIMIT ${batch}
    `);
    const fillNext = this.db.prepare(`
      INSERT INTO vector_knn_backfill_batch(event_id, ordinal, chunk_rowid)
      SELECT ch.event_id, ch.ordinal, ch.rowid
      ${coveredChunks}
        AND (ch.event_id, ch.ordinal) > (?, ?)
      ORDER BY ch.event_id, ch.ordinal
      LIMIT ${batch}
    `);
    const clearBatch = this.db.prepare("DELETE FROM vector_knn_backfill_batch");
    const batchCount = this.db.prepare(
      "SELECT count(*) FROM vector_knn_backfill_batch",
    ).pluck();
    const batchTail = this.db.prepare(`
      SELECT event_id, ordinal
      FROM vector_knn_backfill_batch
      ORDER BY event_id DESC, ordinal DESC
      LIMIT 1
    `);
    const indexedChunks = `
      FROM vector_knn_backfill_batch b
      JOIN chunks ch ON ch.rowid = b.chunk_rowid
      JOIN vector_authorized a ON a.event_id = ch.event_id
    `;
    const insertMessage = this.db.prepare(`
      INSERT INTO vector_authorized_knn_messages(rowid, embedding)
      SELECT ch.rowid, ch.vector
      ${indexedChunks}
      WHERE ch.origin_json IS NULL
        AND (a.body_length IS NULL OR ch."end" <= a.body_length)
    `);
    const insertFile = this.db.prepare(`
      INSERT INTO vector_authorized_knn_files(rowid, embedding)
      SELECT ch.rowid, ch.vector
      ${indexedChunks}
      WHERE ch.origin_json IS NOT NULL
    `);
    const insertRest = this.db.prepare(`
      INSERT INTO vector_authorized_knn_rest(rowid, embedding)
      SELECT ch.rowid, ch.vector
      ${indexedChunks}
      WHERE ch.origin_json IS NULL
        AND a.body_length IS NOT NULL
        AND ch."end" > a.body_length
    `);
    const insertRows = this.db.prepare(`
      INSERT INTO vector_authorized_native_rows(event_id, rowid)
      SELECT ch.event_id, ch.rowid
      ${indexedChunks}
    `);
    let cursor: { event_id: string; ordinal: number } | undefined;
    for (;;) {
      const filled = this.db.transaction(() => {
        clearBatch.run();
        if (cursor) fillNext.run(orgId, generation, cursor.event_id, cursor.ordinal);
        else fillFirst.run(orgId, generation);
        const count = batchCount.get() as number;
        if (count === 0) return 0;
        insertMessage.run();
        insertFile.run();
        insertRest.run();
        insertRows.run();
        return count;
      })();
      if (filled === 0) return;
      const next = batchTail.get() as { event_id: string; ordinal: number } | undefined;
      if (
        !next
        || (
          cursor
          && next.event_id === cursor.event_id
          && next.ordinal === cursor.ordinal
        )
      ) {
        throw new Error("vector backfill cursor did not advance");
      }
      cursor = next;
      await this.yieldEventLoop();
    }
  }

  private stageVectorSkipped(orgId: string, generation: string): void {
    this.db.prepare("DELETE FROM vector_skipped").run();
    this.db.prepare(`
      INSERT INTO vector_skipped(event_id,content_hash)
      SELECT j.event_id,j.content_hash
      FROM vector_authorized a
      JOIN jobs j ON j.event_id=a.event_id AND j.content_hash=a.content_hash
      JOIN source_heads h ON h.org_id=j.org_id AND h.source=j.source
        AND h.external_id=j.external_id AND h.event_id=j.event_id AND h.fence=j.fence
      WHERE j.org_id=? AND j.generation=? AND j.status='skipped'
      ORDER BY j.event_id
    `).run(orgId, generation);
  }

  private rankedNativeChunkCount(): number {
    return this.nativeAuthorizedChunkCount();
  }

  private nativeAuthorizedChunkCount(): number {
    if (!this.nativeVectors || !this.nativeKnnPartitionsReady()) return 0;
    return NATIVE_KNN_PARTITIONS.reduce((sum, partition) => sum + this.nativeKnnCount(partition), 0);
  }

  private nativeKnnPartitionsReady(): boolean {
    return NATIVE_KNN_PARTITIONS.every((partition) => this.mainTableExists(partition));
  }

  private mainTableExists(name: string): boolean {
    return Boolean(this.db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
    ).get(name));
  }

  private knnDimensions(): number | undefined {
    return this.db.prepare(
      "SELECT dimensions FROM vector_knn_meta WHERE singleton=1",
    ).pluck().get() as number | undefined;
  }

  private tempTableExists(name: string): boolean {
    return Boolean(this.db.prepare(
      "SELECT 1 FROM sqlite_temp_master WHERE type='table' AND name=?",
    ).get(name));
  }

  private nativeKnnCount(partition: NativeKnnPartition): number {
    return this.db.prepare(`SELECT count(*) FROM ${partition}`).pluck().get() as number;
  }

  private createNativeKnnTable(partition: NativeKnnPartition, dimensions: number): void {
    if (!Number.isSafeInteger(dimensions) || dimensions < 1) {
      throw new ContextVectorUnavailableError("corrupt");
    }
    this.db.exec(`
      DROP TABLE IF EXISTS ${partition};
      CREATE VIRTUAL TABLE ${partition} USING vec0(
        embedding float[${dimensions}] distance_metric=cosine
      );
    `);
  }

  private nativeKnnPartitionsFor(kind: string | undefined): NativeKnnPartition[] {
    if (kind === "messages") return ["vector_authorized_knn_messages"];
    if (kind === "files") return ["vector_authorized_knn_files"];
    return [...NATIVE_KNN_PARTITIONS];
  }

  private nativeAuthorizedRows(
    input: Parameters<ContextVectorIndex["matchAuthorized"]>[0],
  ): { rows: AuthorizedChunkRow[]; candidateChunks: number } | undefined {
    if (!this.nativeKnnPartitionsReady()) return undefined;
    const partitions = this.nativeKnnPartitionsFor(input.search_kind);
    const counts = partitions.map((partition) => this.nativeKnnCount(partition));
    const total = counts.reduce((sum, count) => sum + count, 0);
    if (total < 1) return { rows: [], candidateChunks: 0 };
    const query = vectorBuffer(input.query_vector);
    const statements = partitions.map((partition) => this.db.prepare(`
      SELECT ch.event_id,v.distance
      FROM ${partition} v
      JOIN chunks ch ON ch.rowid=v.rowid
      WHERE v.embedding MATCH ? AND k=?
      ORDER BY v.distance,ch.event_id
    `));
    let candidateLimit = Math.min(total, Math.max(input.limit * 4, 100));
    let candidates: NativeVectorCandidateRow[] = [];
    let selectedEvents: string[] = [];
    while (candidateLimit > 0) {
      candidates = [];
      const unseenBounds: number[] = [];
      let fullyScanned = true;
      for (let index = 0; index < partitions.length; index += 1) {
        const count = counts[index];
        if (count < 1) continue;
        const window = Math.min(candidateLimit, count);
        const rows = statements[index].all(query, window) as NativeVectorCandidateRow[];
        if (rows.length < 1) throw new ContextVectorUnavailableError("corrupt");
        if (rows.length < window) {
          candidates.push(...rows);
          continue;
        }
        for (const candidate of rows) {
          if (!Number.isFinite(candidate.distance) || candidate.distance < 0 || candidate.distance > 2) {
            throw new ContextVectorUnavailableError("corrupt");
          }
          candidates.push(candidate);
        }
        if (window < count) {
          fullyScanned = false;
          const tail = rows.at(-1)?.distance;
          if (tail === undefined) throw new ContextVectorUnavailableError("corrupt");
          unseenBounds.push(tail);
        }
      }
      for (const candidate of candidates) {
        if (!Number.isFinite(candidate.distance) || candidate.distance < 0 || candidate.distance > 2) {
          throw new ContextVectorUnavailableError("corrupt");
        }
      }
      const best = new Map<string, number>();
      for (const candidate of candidates) {
        const previous = best.get(candidate.event_id);
        if (previous === undefined || candidate.distance < previous) {
          best.set(candidate.event_id, candidate.distance);
        }
      }
      const ranked = [...best].sort((left, right) =>
        left[1] - right[1] || compare(left[0], right[0]));
      selectedEvents = ranked.slice(0, input.limit).map(([eventId]) => eventId);
      const boundary = ranked[input.limit - 1]?.[1];
      const unseenBound = unseenBounds.length ? Math.min(...unseenBounds) : undefined;
      if (
        fullyScanned
        || (
          selectedEvents.length === input.limit
          && boundary !== undefined
          && unseenBound !== undefined
          && boundary < unseenBound
        )
      ) {
        break;
      }
      const next = Math.min(total, candidateLimit * 2);
      if (next === candidateLimit) break;
      candidateLimit = next;
    }
    this.db.exec(`
      CREATE TEMP TABLE IF NOT EXISTS vector_native_candidate_events (
        event_id TEXT PRIMARY KEY
      ) WITHOUT ROWID;
      DELETE FROM vector_native_candidate_events;
    `);
    const insert = this.db.prepare(
      "INSERT INTO vector_native_candidate_events(event_id) VALUES (?)",
    );
    for (const eventId of selectedEvents) insert.run(eventId);
    const rows = this.db.prepare(`
      SELECT c.event_id,c.content_hash,a.body_length,c.chunk_count,
             ch.ordinal,ch.start,ch.end,ch.vector,ch.origin_json,ch.text_hash
      FROM vector_native_candidate_events n
      CROSS JOIN vector_authorized a ON a.event_id=n.event_id
      CROSS JOIN coverage c
        ON c.event_id=a.event_id AND c.content_hash=a.content_hash
      CROSS JOIN source_heads h
        ON h.org_id=c.org_id AND h.source=c.source
        AND h.external_id=c.external_id AND h.event_id=c.event_id
      LEFT JOIN chunks ch
        ON ch.org_id=c.org_id AND ch.generation=c.generation
        AND ch.event_id=c.event_id
      WHERE c.org_id=? AND c.generation=?
      ORDER BY c.event_id,ch.ordinal
    `).all(input.org_id, input.generation) as AuthorizedChunkRow[];
    return { rows, candidateChunks: candidates.length };
  }

  private invalidateVectorAuthorization(): void {
    const partitions = NATIVE_KNN_PARTITIONS.map((partition) => `DROP TABLE IF EXISTS ${partition};`).join("\n");
    this.db.exec(`
      DROP TABLE IF EXISTS temp.vector_authorized_knn;
      ${partitions}
      DROP TABLE IF EXISTS temp.vector_native_candidate_events;
      DELETE FROM vector_knn_meta;
      DELETE FROM vector_ranked_scope;
      DELETE FROM vector_authorized_native_rows;
      DELETE FROM vector_ranked_native_rows;
    `);
    this.rankedScopeKey = undefined;
    this.rankedFilterKey = undefined;
    this.db.prepare("DELETE FROM vector_authorization_state").run();
    this.db.prepare("DELETE FROM vector_uncovered").run();
    this.db.prepare("DELETE FROM vector_skipped").run();
    this.db.prepare("DELETE FROM vector_authorized").run();
  }

  private manifest(orgId: string, id: string): EmbeddingGeneration {
    required(orgId); required(id);
    const row = this.db.prepare("SELECT manifest_json FROM generations WHERE org_id=? AND generation=?")
      .get(orgId, id) as { manifest_json: string } | undefined;
    if (!row) throw new ContextVectorUnavailableError("unbuilt");
    let value: EmbeddingGeneration;
    try {
      value = JSON.parse(row.manifest_json);
      if (canonicalContextJson(value) !== canonicalContextJson(embeddingGeneration(
        value.model, value.chunk_tokens, value.max_chunks_per_event, value.extractor_version,
      ))) {
        throw new ContextVectorUnavailableError("corrupt");
      }
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      throw new ContextVectorUnavailableError("corrupt");
    }
    return value;
  }

  private assertVisualPermission(orgId: string, chunks: ContextVectorChunk[]): void {
    const policy = this.db.prepare("SELECT enabled FROM visual_policies WHERE org_id=?")
      .get(orgId) as { enabled: number } | undefined;
    if (policy?.enabled === 0 && chunks.some((chunk) => chunk.origin?.mode === "visual")) {
      throw new Error("Visual indexing permission is disabled");
    }
  }
}

export const sqliteContextVectorIndexPlugin = definePlugin<{
  path: string; org_id?: string; visual_enabled?: boolean;
}>({
  name: "context-vector-index-sqlite",
  async apply(ctx, options) {
    let index: SqliteContextVectorIndex;
    try {
      index = new SqliteContextVectorIndex(options.path);
    } catch (error) {
      if (!(error instanceof Database.SqliteError) && !(error instanceof VectorIndexSchemaError) &&
        !(error instanceof Error && "code" in error && ["EACCES", "EPERM", "ENOSPC", "EROFS", "ENOENT"].includes(String(error.code)))) {
        throw error;
      }
      console.error("Vector index unavailable", "vector_index_unavailable");
      ctx.provide("context-vector-status", { status: "unavailable", error_code: "vector_index_unavailable" });
      return;
    }
    try {
      if (options.org_id !== undefined) {
        await index.setVisualEnabled(options.org_id, options.visual_enabled === true);
      }
    } catch (error) {
      index.close();
      throw error;
    }
    ctx.provide("context-vector-status", { status: "ready" });
    ctx.provide("context-vector-index", index);
    ctx.provide("context-vector-generations", index);
    ctx.provide("context-embedding-jobs", index);
    ctx.effect(() => () => index.close());
  },
});

function jobFromRow(row: JobRow): EmbeddingJob {
  return {
    id: row.id, org_id: row.org_id, generation: row.generation, source: row.source, external_id: row.external_id,
    event_id: row.event_id, operation: row.operation, lineage: JSON.parse(row.lineage_json),
    fence: row.fence, attempts: row.attempts, status: row.status,
    ...(row.started_at ? { started_at: row.started_at } : {}),
    ...(row.completed_at ? { completed_at: row.completed_at } : {}),
    processing_ms: row.processing_ms,
    ...(row.content_hash ? { content_hash: row.content_hash } : {}),
    ...(row.error_code ? { error_code: row.error_code } : {}),
  };
}
function claimIdFilter(input: { job_id?: number; lane?: "fast" | "slow" }): { sql: string; params: number[] } {
  if (input.job_id !== undefined) {
    if (!Number.isSafeInteger(input.job_id) || input.job_id < 1) throw new Error("Invalid embedding job id");
    return { sql: " AND id=?", params: [input.job_id] };
  }
  if (input.lane === "fast") return { sql: " AND lane IS NULL", params: [] };
  if (input.lane === "slow") return { sql: " AND lane='slow'", params: [] };
  if (input.lane !== undefined) throw new Error("Invalid embedding claim lane");
  return { sql: "", params: [] };
}

function required(value: string): void { if (typeof value !== "string" || !value.trim()) throw new Error("Vector namespace is required"); }
function validHash(value: string | undefined): boolean { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function validateAuthorizationKey(key: ContextVectorAuthorizationKey): void {
  required(key.event_id);
  if (!validHash(key.content_hash)) throw new Error("Invalid vector authorization key");
  if (key.body_length !== undefined) bounded(key.body_length, 0, Number.MAX_SAFE_INTEGER);
}
function timestamp(value: string): void { if (typeof value !== "string" || new Date(value).toISOString() !== value) throw new Error("Invalid vector timestamp"); }
function bounded(value: number, min: number, max: number): void { if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error("Invalid vector limit"); }
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
interface RankedVectorRow {
  event_id: string;
  content_hash: string;
  ordinal: number;
  start: number;
  end: number;
  vector: Buffer;
  distance: number;
}

interface SequencedAuthorityHead extends ChangedAuthorityHead {
  sequence: number;
  has_job: number;
}

interface ChangedAuthorityHead {
  source: string;
  external_id: string;
  event_id: string;
  operation: string;
  content_hash: string | null;
  parent_event_id: string | null;
  thread_id: string | null;
  actor_id: string | null;
  required_scope_ids_json: string | null;
  media_type: string | null;
}

interface ChangedAuthorityChain {
  head_id: string;
  id: string;
  parent_event_id: string | null;
  operation: string;
  depth: number;
}

function changedHeadEligible(row: ChangedAuthorityHead): boolean {
  if (!row.thread_id?.trim() || !row.actor_id?.trim()) return false;
  if (!["create", "revise", "tombstone"].includes(row.operation)) return false;
  let scopes: unknown;
  try {
    scopes = JSON.parse(row.required_scope_ids_json ?? "");
  } catch {
    return false;
  }
  if (!Array.isArray(scopes) || scopes.length === 0 || scopes.some((scope) => typeof scope !== "string" || !scope.trim())) {
    return false;
  }
  if (row.operation === "tombstone") return true;
  return Boolean(row.content_hash && row.media_type?.trim());
}

function lineageFor(rows: ChangedAuthorityChain[], headId: string): string[] | undefined {
  const ordered = [...rows].sort((left, right) => right.depth - left.depth);
  const root = ordered[0];
  if (!root || root.operation !== "create" || root.parent_event_id) return undefined;
  const lineage = ordered.map((row) => row.id);
  if (lineage.at(-1) !== headId || new Set(lineage).size !== lineage.length) return undefined;
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index]?.parent_event_id !== ordered[index - 1]?.id) return undefined;
  }
  return lineage;
}

function withAttachedAuthority<T>(db: Database.Database, path: string, run: () => T): T {
  if (!path || path === ":memory:" || path.includes("\0")) {
    throw new Error("Authority database path cannot be attached");
  }
  const attached = db.prepare("SELECT 1 FROM pragma_database_list WHERE name = 'regenic_auth'").get();
  if (attached) db.exec("DETACH DATABASE regenic_auth");
  db.prepare("ATTACH DATABASE ? AS regenic_auth").run(path);
  try {
    return run();
  } finally {
    db.exec("DETACH DATABASE regenic_auth");
  }
}

function rankedCosine(vector: Buffer, query: number[], queryNorm: number, dimensions: number): number {
  if (vector.byteLength !== dimensions * 4 || !Number.isFinite(queryNorm) || queryNorm === 0) {
    throw new ContextVectorUnavailableError("corrupt");
  }
  let dot = 0;
  let squared = 0;
  for (let index = 0; index < dimensions; index += 1) {
    const value = vector.readFloatLE(index * 4);
    if (!Number.isFinite(value)) throw new ContextVectorUnavailableError("corrupt");
    dot += value * query[index]!;
    squared += value * value;
  }
  const vectorNorm = Math.sqrt(squared);
  if (!Number.isFinite(vectorNorm) || Math.abs(vectorNorm - 1) > 0.001) {
    throw new ContextVectorUnavailableError("corrupt");
  }
  return Number(Math.max(-1, Math.min(1, dot / (queryNorm * vectorNorm))).toFixed(9));
}

function vectorBuffer(vector: number[]): Buffer {
  const buffer = Buffer.allocUnsafe(vector.length * 4);
  vector.forEach((value, index) => buffer.writeFloatLE(value, index * 4));
  return buffer;
}
