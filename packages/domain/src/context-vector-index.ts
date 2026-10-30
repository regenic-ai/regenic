import type { ContextLexicalKey } from "./context-lexical";
import type { EmbeddingGeneration } from "./embedding-provider";

export class ContextVectorUnavailableError extends Error {
  constructor(readonly reason: "unbuilt" | "corrupt" | "unavailable") {
    super(reason === "unbuilt" ? "Vector generation is not registered" : `Vector index ${reason}`);
    this.name = "ContextVectorUnavailableError";
  }
}

export class EmbeddingGenerationNotReadyError extends Error {
  constructor(readonly reason: "authority_changed" | "backfill_incomplete") {
    super(reason === "authority_changed"
      ? "Authority changed during activation; retry after reconciliation at the current Authority epoch"
      : "Generation is not fully covered; backfill or retry first");
    this.name = "EmbeddingGenerationNotReadyError";
  }
}

export interface ContextVectorChunk {
  ordinal: number;
  start: number;
  end: number;
  text_hash: string;
  vector: number[];
  origin?: import("./context-search").ContextChunkOrigin;
}

export interface ContextVectorMatch extends ContextLexicalKey {
  score: number;
  chunk_ordinal: number;
  start: number;
  end: number;
  material_length?: number;
  search_matches?: Array<{
    origin: import("./context-search").ContextChunkOrigin;
    score: number;
    lexical: boolean;
  }>;
}

export interface ContextVectorIndex {
  matchAuthorizedText?(input: {
    org_id: string;
    generation: string;
    authorized: Array<ContextLexicalKey & { body_length?: number }>;
    query: string;
    limit: number;
  }): ReturnType<ContextVectorIndex["matchAuthorized"]>;
  registerGeneration(orgId: string, generation: EmbeddingGeneration): Promise<void>;
  matchAuthorized(input: {
    org_id: string;
    generation: string;
    authorized: Array<ContextLexicalKey & { body_length?: number }>;
    query_vector: number[];
    limit: number;
    query?: string;
    search_kind?: import("./context-search").ContextSearchKind;
  }): Promise<{
    generation: string;
    covered: ContextLexicalKey[];
    skipped?: ContextLexicalKey[];
    matched: ContextVectorMatch[];
    reconciled_epoch?: string;
  }>;
  clearOrganization(orgId: string): Promise<void>;
}

export interface EmbeddingSourceHead {
  source: string;
  external_id: string;
  event_id: string;
  content_hash?: string;
  operation: "create" | "revise" | "tombstone";
  lineage: string[];
}

export interface ContextVectorGenerationStore {
  listGenerations(orgId: string): Promise<Array<{
    manifest: EmbeddingGeneration;
    active: boolean;
    previously_active?: boolean;
    reconciled_epoch?: string;
  }>>;
  activeGeneration(orgId: string): Promise<EmbeddingGeneration | undefined>;
  activateGeneration(input: {
    org_id: string;
    generation: string;
    read_epoch: string;
    required: ContextLexicalKey[];
  }): Promise<void>;
  removeGeneration(orgId: string, generation: string): Promise<void>;
}

export interface EmbeddingJob extends EmbeddingSourceHead {
  id: number;
  org_id: string;
  generation: string;
  fence: number;
  attempts: number;
  status: "pending" | "running" | "succeeded" | "skipped" | "failed" | "quarantined" | "superseded";
  error_code?: string;
}

export interface EmbeddingJobSummary {
  counts: Record<EmbeddingJob["status"], number>;
  failures: Array<{ error_code: string; failed: number; quarantined: number }>;
}

export interface EmbeddingJobStore {
  reconcile(input: {
    org_id: string;
    generation: string;
    read_epoch: string;
    heads: EmbeddingSourceHead[];
    now: string;
  }): Promise<void>;
  claim(input: {
    org_id: string;
    generation: string;
    owner: string;
    now: string;
    lease_ms: number;
    limit: number;
  }): Promise<EmbeddingJob[]>;
  renew(job: EmbeddingJob, owner: string, now: string, leaseMs: number): Promise<boolean>;
  complete(input: {
    job: EmbeddingJob;
    owner: string;
    now: string;
    chunks: ContextVectorChunk[];
    no_content?: boolean;
  }): Promise<boolean>;
  fail(input: {
    job: EmbeddingJob;
    owner: string;
    now: string;
    retry_at: string;
    error_code: string;
    retryable: boolean;
  }): Promise<boolean>;
  listJobs(orgId: string, generation: string): Promise<EmbeddingJob[]>;
  summarizeJobs(orgId: string, generation: string): Promise<EmbeddingJobSummary>;
  loadStagedChunks(job: EmbeddingJob, owner: string, now: string): Promise<ContextVectorChunk[]>;
  stageChunk(input: { job: EmbeddingJob; owner: string; now: string; chunk: ContextVectorChunk }): Promise<boolean>;
  yieldJob(job: EmbeddingJob, owner: string, now: string): Promise<boolean>;
  retryQuarantined(orgId: string, generation: string, eventId: string): Promise<boolean>;
  retryFailed(orgId: string, generation: string, limit: number): Promise<number>;
}

export interface ContextEmbeddingRunner {
  runOnce(options?: {
    /** Stop claiming new work after this many jobs. In-flight work is always drained. */
    max_jobs?: number;
    /** Soft wall-clock budget checked between jobs. */
    time_budget_ms?: number;
    /** Yield before claiming another job, for example when interactive work resumes. */
    pause_if?: () => boolean;
  }): Promise<{ processed: number; failed: number; superseded: number }>;
  stop(): Promise<void>;
  clearProjection(): Promise<void>;
}
