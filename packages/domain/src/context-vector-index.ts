import type { ContextLexicalKey } from "./context-lexical";
import type { EmbeddingGeneration } from "./embedding-provider";

export class ContextVectorUnavailableError extends Error {
  constructor(readonly reason: "unbuilt" | "corrupt" | "unavailable") {
    super(reason === "unbuilt" ? "Vector generation is not registered" : `Vector index ${reason}`);
    this.name = "ContextVectorUnavailableError";
  }
}

export interface ContextVectorChunk {
  ordinal: number;
  start: number;
  end: number;
  text_hash: string;
  vector: number[];
}

export interface ContextVectorMatch extends ContextLexicalKey {
  score: number;
  chunk_ordinal: number;
  start: number;
  end: number;
}

export interface ContextVectorIndex {
  registerGeneration(orgId: string, generation: EmbeddingGeneration): Promise<void>;
  matchAuthorized(input: {
    org_id: string;
    generation: string;
    authorized: ContextLexicalKey[];
    query_vector: number[];
    limit: number;
  }): Promise<{
    generation: string;
    covered: ContextLexicalKey[];
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

export interface EmbeddingJob extends EmbeddingSourceHead {
  id: number;
  org_id: string;
  generation: string;
  fence: number;
  attempts: number;
  status: "pending" | "running" | "succeeded" | "failed" | "quarantined" | "superseded";
  error_code?: string;
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
  retryQuarantined(orgId: string, generation: string, eventId: string): Promise<boolean>;
}

export interface ContextEmbeddingRunner {
  runOnce(): Promise<{ processed: number; failed: number; superseded: number }>;
  stop(): Promise<void>;
  clearProjection(): Promise<void>;
}
