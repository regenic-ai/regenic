import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { definePlugin } from "@regenic/plugin-host";
import {
  canonicalContextJson,
  embeddingGeneration,
  validateEmbeddingVector,
  type ContextVectorIndex,
  type ContextVectorChunk,
  type EmbeddingGeneration,
  type EmbeddingJob,
  type EmbeddingJobStore,
} from "@regenic/domain";

export class VectorIndexSchemaError extends Error {}

interface JobRow {
  id: number; org_id: string; generation: string; source: string; external_id: string;
  event_id: string; content_hash: string | null; operation: EmbeddingJob["operation"];
  lineage_json: string; fence: number; attempts: number; status: EmbeddingJob["status"]; error_code: string | null;
}

export class SqliteContextVectorIndex implements ContextVectorIndex, EmbeddingJobStore {
  private readonly db: Database.Database;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    try {
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("foreign_keys = ON");
      this.db.pragma("secure_delete = ON");
      this.db.pragma("busy_timeout = 5000");
      const version = this.db.pragma("user_version", { simple: true });
      if (version !== 0 && version !== 1) throw new VectorIndexSchemaError("Unsupported vector index schema");
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS generations (
            org_id TEXT NOT NULL, generation TEXT NOT NULL, manifest_json TEXT NOT NULL, reconciled_epoch TEXT,
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
            UNIQUE (org_id, generation, event_id),
            FOREIGN KEY (org_id, generation) REFERENCES generations(org_id, generation) ON DELETE CASCADE
          );
          CREATE INDEX IF NOT EXISTS jobs_due ON jobs(org_id, generation, status, retry_at, lease_until, id);
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
          PRAGMA user_version = 1;
        `);
      }).immediate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void { if (this.db.open) this.db.close(); }

  async registerGeneration(orgId: string, generation: EmbeddingGeneration): Promise<void> {
    required(orgId);
    const expected = embeddingGeneration(generation.model, generation.chunk_tokens, generation.max_chunks_per_event);
    if (canonicalContextJson(generation) !== canonicalContextJson(expected)) throw new Error("Invalid vector generation manifest");
    this.db.prepare("INSERT OR IGNORE INTO generations(org_id,generation,manifest_json) VALUES (?,?,?)")
      .run(orgId, generation.id, canonicalContextJson(generation));
    this.manifest(orgId, generation.id);
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
      for (const head of input.heads) {
        const previous = this.db.prepare("SELECT event_id,fence FROM source_heads WHERE org_id=? AND source=? AND external_id=?")
          .get(input.org_id, head.source, head.external_id) as { event_id: string; fence: number } | undefined;
        if (previous && !head.lineage.includes(previous.event_id)) throw new Error("Stale embedding lifecycle view");
        const fence = previous ? previous.fence + Number(previous.event_id !== head.event_id) : 1;
        this.db.prepare(`INSERT INTO source_heads VALUES (?,?,?,?,?)
          ON CONFLICT(org_id,source,external_id) DO UPDATE SET event_id=excluded.event_id,fence=excluded.fence`)
          .run(input.org_id, head.source, head.external_id, head.event_id, fence);
        if (previous?.event_id !== head.event_id) {
          this.db.prepare("DELETE FROM coverage WHERE org_id=? AND source=? AND external_id=?")
            .run(input.org_id, head.source, head.external_id);
          this.db.prepare(`UPDATE jobs SET status='superseded',owner=NULL,lease_until=NULL
            WHERE org_id=? AND source=? AND external_id=? AND event_id<>?`)
            .run(input.org_id, head.source, head.external_id, head.event_id);
        }
        this.db.prepare(`INSERT OR IGNORE INTO jobs (
          org_id,generation,source,external_id,event_id,content_hash,operation,lineage_json,fence,status
        ) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
          input.org_id, input.generation, head.source, head.external_id, head.event_id, head.content_hash ?? null,
          head.operation, canonicalContextJson(head.lineage), fence, head.operation === "tombstone" ? "succeeded" : "pending",
        );
      }
      this.db.prepare("UPDATE generations SET reconciled_epoch=? WHERE org_id=? AND generation=?")
        .run(input.read_epoch, input.org_id, input.generation);
    }).immediate();
  }

  async claim(input: Parameters<EmbeddingJobStore["claim"]>[0]): Promise<EmbeddingJob[]> {
    required(input.org_id); required(input.generation); required(input.owner); timestamp(input.now);
    bounded(input.lease_ms, 1, 300000); bounded(input.limit, 1, 100);
    return this.db.transaction(() => {
      const rows = this.db.prepare(`SELECT * FROM jobs WHERE org_id=? AND generation=? AND (
        status='pending' OR (status='failed' AND retry_at<=?) OR (status='running' AND lease_until<=?)
      ) ORDER BY id LIMIT ?`).all(input.org_id, input.generation, input.now, input.now, input.limit) as JobRow[];
      const until = new Date(Date.parse(input.now) + input.lease_ms).toISOString();
      for (const row of rows) {
        this.db.prepare("UPDATE jobs SET status='running',owner=?,lease_until=?,attempts=attempts+1,error_code=NULL WHERE id=?")
          .run(input.owner, until, row.id);
        row.status = "running"; row.attempts += 1; row.error_code = null;
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

  async complete(input: Parameters<EmbeddingJobStore["complete"]>[0]): Promise<boolean> {
    const { job, owner, now, chunks } = input;
    required(owner); timestamp(now);
    const generation = this.manifest(job.org_id, job.generation);
    if (!validHash(job.content_hash) || !Array.isArray(chunks) || chunks.length === 0 ||
      chunks.length > generation.max_chunks_per_event) throw new Error("Invalid embedding publication");
    let end = 0;
    for (const [ordinal, chunk] of chunks.entries()) {
      if (chunk.ordinal !== ordinal || !Number.isSafeInteger(chunk.start) || !Number.isSafeInteger(chunk.end) ||
        chunk.start !== end || chunk.end <= chunk.start || !validHash(chunk.text_hash)) throw new Error("Invalid embedding chunk");
      validateEmbeddingVector(chunk.vector, generation.model.dimensions);
      end = chunk.end;
    }
    return this.db.transaction(() => {
      const current = this.db.prepare(`SELECT j.id FROM jobs j JOIN source_heads h
        ON h.org_id=j.org_id AND h.source=j.source AND h.external_id=j.external_id
        WHERE j.id=? AND j.org_id=? AND j.generation=? AND j.event_id=? AND j.content_hash=?
        AND j.source=? AND j.external_id=? AND j.fence=? AND j.status='running' AND j.owner=? AND j.lease_until>?
        AND h.event_id=j.event_id AND h.fence=j.fence`)
        .get(job.id, job.org_id, job.generation, job.event_id, job.content_hash, job.source, job.external_id, job.fence, owner, now);
      if (!current) return false;
      this.db.prepare("DELETE FROM coverage WHERE org_id=? AND generation=? AND event_id=?")
        .run(job.org_id, job.generation, job.event_id);
      this.db.prepare("INSERT INTO coverage VALUES (?,?,?,?,?,?,?)")
        .run(job.org_id, job.generation, job.event_id, job.content_hash, job.source, job.external_id, chunks.length);
      for (const chunk of chunks) {
        const bytes = Buffer.alloc(chunk.vector.length * 4);
        chunk.vector.forEach((value, index) => bytes.writeFloatLE(value, index * 4));
        this.db.prepare("INSERT INTO chunks VALUES (?,?,?,?,?,?,?,?)")
          .run(job.org_id, job.generation, job.event_id, chunk.ordinal, chunk.start, chunk.end, chunk.text_hash, bytes);
      }
      this.db.prepare("UPDATE jobs SET status='succeeded',owner=NULL,lease_until=NULL,retry_at=NULL,error_code=NULL WHERE id=?").run(job.id);
      return true;
    }).immediate();
  }

  async fail(input: Parameters<EmbeddingJobStore["fail"]>[0]): Promise<boolean> {
    const { job, owner, now } = input;
    required(owner); timestamp(now); timestamp(input.retry_at);
    if (!/^[a-z_]{1,64}$/.test(input.error_code)) throw new Error("Invalid embedding error code");
    return this.db.prepare(`UPDATE jobs SET status=?,retry_at=?,error_code=?,owner=NULL,lease_until=NULL
      WHERE id=? AND org_id=? AND generation=? AND status='running' AND owner=? AND lease_until>? AND fence=?`)
      .run(input.retryable ? "failed" : "quarantined", input.retry_at, input.error_code,
        job.id, job.org_id, job.generation, owner, now, job.fence).changes === 1;
  }

  async listJobs(orgId: string, generation: string): Promise<EmbeddingJob[]> {
    required(orgId); required(generation);
    return (this.db.prepare("SELECT * FROM jobs WHERE org_id=? AND generation=? ORDER BY id")
      .all(orgId, generation) as JobRow[]).map(jobFromRow);
  }

  async retryQuarantined(orgId: string, generation: string, eventId: string): Promise<boolean> {
    required(orgId); required(generation); required(eventId);
    return this.db.prepare(`UPDATE jobs SET status='pending',retry_at=NULL,error_code=NULL
      WHERE org_id=? AND generation=? AND event_id=? AND status='quarantined'
      AND EXISTS (SELECT 1 FROM source_heads h WHERE h.org_id=jobs.org_id
        AND h.source=jobs.source AND h.external_id=jobs.external_id AND h.event_id=jobs.event_id AND h.fence=jobs.fence)`)
      .run(orgId, generation, eventId).changes === 1;
  }

  async matchAuthorized(input: Parameters<ContextVectorIndex["matchAuthorized"]>[0]): ReturnType<ContextVectorIndex["matchAuthorized"]> {
    const generation = this.manifest(input.org_id, input.generation);
    validateEmbeddingVector(input.query_vector, generation.model.dimensions);
    const queryNorm = Math.sqrt(input.query_vector.reduce((sum, value) => sum + value * value, 0));
    bounded(input.limit, 1, 1000);
    if (!Array.isArray(input.authorized) || input.authorized.length > 10000) throw new Error("Invalid vector authorization set");
    const seen = new Set<string>();
    for (const key of input.authorized) {
      required(key.event_id);
      if (!validHash(key.content_hash) || seen.has(key.event_id)) throw new Error("Invalid vector authorization key");
      seen.add(key.event_id);
    }
    return this.db.transaction(() => {
      const covered = [];
      const matched = [];
      for (const key of input.authorized) {
        const coverage = this.db.prepare(`SELECT c.chunk_count FROM coverage c JOIN source_heads h
          ON h.org_id=c.org_id AND h.source=c.source AND h.external_id=c.external_id AND h.event_id=c.event_id
          WHERE c.org_id=? AND c.generation=? AND c.event_id=? AND c.content_hash=?`)
          .get(input.org_id, input.generation, key.event_id, key.content_hash) as { chunk_count: number } | undefined;
        if (!coverage) continue;
        const chunks = this.db.prepare("SELECT * FROM chunks WHERE org_id=? AND generation=? AND event_id=? ORDER BY ordinal")
          .all(input.org_id, input.generation, key.event_id) as Array<{ ordinal: number; start: number; end: number; vector: Buffer }>;
        if (chunks.length !== coverage.chunk_count || chunks.length === 0) throw new Error("Incomplete vector coverage");
        let best: { score: number; chunk_ordinal: number; start: number; end: number } | undefined;
        for (const chunk of chunks) {
          if (chunk.vector.byteLength !== generation.model.dimensions * 4) throw new Error("Corrupt vector dimensions");
          const vector = Array.from({ length: generation.model.dimensions }, (_, i) => chunk.vector.readFloatLE(i * 4));
          validateEmbeddingVector(vector, generation.model.dimensions);
          const vectorNorm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
          const cosine = vector.reduce((sum, value, i) => sum + value * input.query_vector[i], 0) / (queryNorm * vectorNorm);
          const score = Number(Math.max(-1, Math.min(1, cosine)).toFixed(9));
          if (!best || score > best.score) best = { score, chunk_ordinal: chunk.ordinal, start: chunk.start, end: chunk.end };
        }
        covered.push({ ...key });
        matched.push({ ...key, ...best! });
      }
      matched.sort((a, b) => b.score - a.score || compare(a.event_id, b.event_id));
      covered.sort((a, b) => compare(a.event_id, b.event_id));
      const meta = this.db.prepare("SELECT reconciled_epoch FROM generations WHERE org_id=? AND generation=?")
        .get(input.org_id, input.generation) as { reconciled_epoch: string | null };
      return { generation: input.generation, covered, matched: matched.slice(0, input.limit), ...(meta.reconciled_epoch ? { reconciled_epoch: meta.reconciled_epoch } : {}) };
    })();
  }

  async clearOrganization(orgId: string): Promise<void> {
    required(orgId);
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM generations WHERE org_id=?").run(orgId);
      this.db.prepare("DELETE FROM source_heads WHERE org_id=?").run(orgId);
    }).immediate();
    this.db.pragma("wal_checkpoint(TRUNCATE)");
  }

  private manifest(orgId: string, id: string): EmbeddingGeneration {
    required(orgId); required(id);
    const row = this.db.prepare("SELECT manifest_json FROM generations WHERE org_id=? AND generation=?")
      .get(orgId, id) as { manifest_json: string } | undefined;
    if (!row) throw new Error("Vector generation is not registered");
    const value: EmbeddingGeneration = JSON.parse(row.manifest_json);
    if (canonicalContextJson(value) !== canonicalContextJson(embeddingGeneration(value.model, value.chunk_tokens, value.max_chunks_per_event))) {
      throw new Error("Corrupt vector generation manifest");
    }
    return value;
  }
}

export const sqliteContextVectorIndexPlugin = definePlugin<{ path: string }>({
  name: "context-vector-index-sqlite",
  apply(ctx, options) {
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
    ctx.provide("context-vector-status", { status: "ready" });
    ctx.provide("context-vector-index", index);
    ctx.provide("context-embedding-jobs", index);
    ctx.effect(() => () => index.close());
  },
});

function jobFromRow(row: JobRow): EmbeddingJob {
  return {
    id: row.id, org_id: row.org_id, generation: row.generation, source: row.source, external_id: row.external_id,
    event_id: row.event_id, operation: row.operation, lineage: JSON.parse(row.lineage_json),
    fence: row.fence, attempts: row.attempts, status: row.status,
    ...(row.content_hash ? { content_hash: row.content_hash } : {}),
    ...(row.error_code ? { error_code: row.error_code } : {}),
  };
}
function required(value: string): void { if (typeof value !== "string" || !value.trim()) throw new Error("Vector namespace is required"); }
function validHash(value: string | undefined): boolean { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function timestamp(value: string): void { if (typeof value !== "string" || new Date(value).toISOString() !== value) throw new Error("Invalid vector timestamp"); }
function bounded(value: number, min: number, max: number): void { if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error("Invalid vector limit"); }
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
