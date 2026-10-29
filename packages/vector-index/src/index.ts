import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { definePlugin } from "@regenic/plugin-host";
import {
  canonicalContextJson,
  embeddingGeneration,
  validateEmbeddingVector,
  ContextVectorUnavailableError,
  type ContextVectorIndex,
  type ContextVectorGenerationStore,
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

interface AuthorizedChunkRow {
  event_id: string;
  content_hash: string;
  chunk_count: number;
  ordinal: number | null;
  start: number | null;
  end: number | null;
  vector: Buffer | null;
}

export class SqliteContextVectorIndex implements ContextVectorIndex, ContextVectorGenerationStore, EmbeddingJobStore {
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
      if (version !== 0 && version !== 1 && version !== 2) throw new VectorIndexSchemaError("Unsupported vector index schema");
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
          CREATE TABLE IF NOT EXISTS active_generations (
            org_id TEXT PRIMARY KEY, generation TEXT NOT NULL,
            FOREIGN KEY (org_id, generation) REFERENCES generations(org_id, generation) ON DELETE CASCADE
          );
          CREATE TABLE IF NOT EXISTS retired_generations (
            org_id TEXT NOT NULL, generation TEXT NOT NULL, manifest_json TEXT NOT NULL, retired_at TEXT NOT NULL,
            PRIMARY KEY (org_id, generation)
          );
          CREATE TEMP TABLE IF NOT EXISTS vector_authorized (
            event_id TEXT PRIMARY KEY,
            content_hash TEXT NOT NULL
          ) WITHOUT ROWID;
          PRAGMA user_version = 2;
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
    this.db.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM retired_generations WHERE org_id=? AND generation=?").get(orgId, generation.id)) {
        throw new Error("Generation was collected; use a new recipe or explicitly clear the projection");
      }
      this.db.prepare("INSERT OR IGNORE INTO generations(org_id,generation,manifest_json) VALUES (?,?,?)")
        .run(orgId, generation.id, canonicalContextJson(generation));
      this.manifest(orgId, generation.id);
      this.db.prepare("INSERT OR IGNORE INTO active_generations VALUES (?,?)").run(orgId, generation.id);
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
      if (row.reconciled_epoch !== input.read_epoch) throw new Error("Generation requires reconciliation at the current Authority epoch");
      for (const key of input.required) {
        const coverage = this.db.prepare(`SELECT c.chunk_count FROM coverage c JOIN source_heads h
          ON h.org_id=c.org_id AND h.source=c.source AND h.external_id=c.external_id AND h.event_id=c.event_id
          WHERE c.org_id=? AND c.generation=? AND c.event_id=? AND c.content_hash=?`)
          .get(input.org_id, input.generation, key.event_id, key.content_hash) as { chunk_count: number } | undefined;
        if (!coverage) throw new Error("Generation is not fully covered; backfill or retry first");
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
    try {
      return await this.matchAuthorizedView(input);
    } catch (error) {
      if (error instanceof Database.SqliteError) throw new ContextVectorUnavailableError("unavailable");
      throw error;
    }
  }

  private async matchAuthorizedView(input: Parameters<ContextVectorIndex["matchAuthorized"]>[0]): ReturnType<ContextVectorIndex["matchAuthorized"]> {
    const generation = this.manifest(input.org_id, input.generation);
    validateEmbeddingVector(input.query_vector, generation.model.dimensions);
    const queryNorm = Math.sqrt(input.query_vector.reduce((sum, value) => sum + value * value, 0));
    bounded(input.limit, 1, 1000);
    if (!Array.isArray(input.authorized)) throw new Error("Invalid vector authorization set");
    const seen = new Set<string>();
    for (const key of input.authorized) {
      required(key.event_id);
      if (!validHash(key.content_hash) || seen.has(key.event_id)) throw new Error("Invalid vector authorization key");
      seen.add(key.event_id);
    }
    return this.db.transaction(() => {
      this.db.prepare("DELETE FROM vector_authorized").run();
      const authorize = this.db.prepare(
        "INSERT INTO vector_authorized (event_id, content_hash) VALUES (?, ?)",
      );
      for (const key of input.authorized) {
        authorize.run(key.event_id, key.content_hash);
      }
      const rows = this.db.prepare(`
        SELECT c.event_id, c.content_hash, c.chunk_count,
               ch.ordinal, ch.start, ch.end, ch.vector
        FROM vector_authorized a
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
      const matched: Array<{
        event_id: string;
        content_hash: string;
        score: number;
        chunk_ordinal: number;
        start: number;
        end: number;
      }> = [];
      const rank = (a: { score: number; event_id: string }, b: { score: number; event_id: string }) =>
        b.score - a.score || compare(a.event_id, b.event_id);
      for (let offset = 0; offset < rows.length;) {
        const first = rows[offset];
        let best: { score: number; chunk_ordinal: number; start: number; end: number } | undefined;
        let chunks = 0;
        while (offset < rows.length && rows[offset].event_id === first.event_id) {
          const chunk = rows[offset];
          if (
            chunk.content_hash !== first.content_hash
            || chunk.chunk_count !== first.chunk_count
            || !Number.isSafeInteger(chunk.ordinal)
            || !Number.isSafeInteger(chunk.start)
            || !Number.isSafeInteger(chunk.end)
            || !Buffer.isBuffer(chunk.vector)
          ) {
            throw new ContextVectorUnavailableError("corrupt");
          }
          const score = cosineScore(
            chunk.vector,
            input.query_vector,
            queryNorm,
            generation.model.dimensions,
          );
          if (!best || score > best.score) {
            best = {
              score,
              chunk_ordinal: chunk.ordinal!,
              start: chunk.start!,
              end: chunk.end!,
            };
          }
          chunks += 1;
          offset += 1;
        }
        if (!best || chunks !== first.chunk_count) {
          throw new ContextVectorUnavailableError("corrupt");
        }
        const key = { event_id: first.event_id, content_hash: first.content_hash };
        covered.push(key);
        matched.push({ ...key, ...best });
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
      this.db.prepare("DELETE FROM retired_generations WHERE org_id=?").run(orgId);
    }).immediate();
    this.db.pragma("wal_checkpoint(TRUNCATE)");
  }

  private manifest(orgId: string, id: string): EmbeddingGeneration {
    required(orgId); required(id);
    const row = this.db.prepare("SELECT manifest_json FROM generations WHERE org_id=? AND generation=?")
      .get(orgId, id) as { manifest_json: string } | undefined;
    if (!row) throw new ContextVectorUnavailableError("unbuilt");
    let value: EmbeddingGeneration;
    try {
      value = JSON.parse(row.manifest_json);
      if (canonicalContextJson(value) !== canonicalContextJson(embeddingGeneration(value.model, value.chunk_tokens, value.max_chunks_per_event))) {
        throw new ContextVectorUnavailableError("corrupt");
      }
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      throw new ContextVectorUnavailableError("corrupt");
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
    ...(row.content_hash ? { content_hash: row.content_hash } : {}),
    ...(row.error_code ? { error_code: row.error_code } : {}),
  };
}
function required(value: string): void { if (typeof value !== "string" || !value.trim()) throw new Error("Vector namespace is required"); }
function validHash(value: string | undefined): boolean { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function timestamp(value: string): void { if (typeof value !== "string" || new Date(value).toISOString() !== value) throw new Error("Invalid vector timestamp"); }
function bounded(value: number, min: number, max: number): void { if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error("Invalid vector limit"); }
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
