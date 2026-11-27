import { createHash } from "node:crypto";
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

export interface ContextVectorAuthorizationKey extends ContextLexicalKey {
  body_length?: number;
}

export interface ContextVectorAuthorizationDelta {
  previous_authorization_hash: string;
  previous_accumulator: string;
  accumulator: string;
  added: ContextVectorAuthorizationKey[];
  removed: ContextVectorAuthorizationKey[];
}

export interface ContextVectorCoverageProof {
  authorization_hash: string;
  authorized_count: number;
  covered_count: number;
  complete: boolean;
  uncovered: ContextLexicalKey[];
}

export interface ContextVectorAcceleration {
  algorithm_version: "sqlite-vec-authorized-exact-v1";
  authorized_chunks: number;
  candidate_chunks: number;
  authorization_update?: "rebuilt" | "reused" | "delta";
  added_events?: number;
  removed_events?: number;
}

export function contextVectorAuthorizationHash(
  keys: readonly ContextVectorAuthorizationKey[],
): string {
  return contextVectorAuthorizationHashFromAccumulator(
    keys.length,
    contextVectorAuthorizationAccumulator(keys),
  );
}

export function contextVectorAuthorizationAccumulator(
  keys: readonly ContextVectorAuthorizationKey[],
): string {
  let accumulator = 0n;
  for (const key of keys) {
    accumulator = addAuthorizationAccumulator(accumulator, key);
  }
  return accumulator.toString(16).padStart(64, "0");
}

export function updateContextVectorAuthorizationAccumulator(
  accumulator: string,
  added: readonly ContextVectorAuthorizationKey[],
  removed: readonly ContextVectorAuthorizationKey[],
): string {
  let value = parseAuthorizationAccumulator(accumulator);
  for (const key of removed) {
    value = subtractAuthorizationAccumulator(value, key);
  }
  for (const key of added) {
    value = addAuthorizationAccumulator(value, key);
  }
  return value.toString(16).padStart(64, "0");
}

export function contextVectorAuthorizationHashFromAccumulator(
  count: number,
  accumulator: string,
): string {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("Invalid vector authorization count");
  }
  const normalized = parseAuthorizationAccumulator(accumulator)
    .toString(16)
    .padStart(64, "0");
  const hash = createHash("sha256");
  hash.update(`regenic-vector-authorization-v2\0${count}\0${normalized}`);
  return hash.digest("hex");
}

const AUTHORIZATION_ACCUMULATOR_MODULUS = 1n << 256n;

function authorizationKeyDigest(key: ContextVectorAuthorizationKey): bigint {
  const bodyLength = key.body_length === undefined ? "-" : String(key.body_length);
  return BigInt(`0x${createHash("sha256").update(
    `${key.event_id.length}:${key.event_id}${key.content_hash}${bodyLength.length}:${bodyLength}`,
  ).digest("hex")}`);
}

function addAuthorizationAccumulator(
  accumulator: bigint,
  key: ContextVectorAuthorizationKey,
): bigint {
  return (accumulator + authorizationKeyDigest(key)) % AUTHORIZATION_ACCUMULATOR_MODULUS;
}

function subtractAuthorizationAccumulator(
  accumulator: bigint,
  key: ContextVectorAuthorizationKey,
): bigint {
  return (
    accumulator
    - authorizationKeyDigest(key)
    + AUTHORIZATION_ACCUMULATOR_MODULUS
  ) % AUTHORIZATION_ACCUMULATOR_MODULUS;
}

function parseAuthorizationAccumulator(value: string): bigint {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Error("Invalid vector authorization accumulator");
  }
  return BigInt(`0x${value}`);
}

export interface ContextVectorIndex {
  /**
   * Nearest current heads. Authorization comes from the attached authority file,
   * not from a key list copied into the process.
   */
  matchRanked?(
    input: import("./search-head-filter").RankedHeadQuery & {
      generation: string;
      query_vector: number[];
      limit: number;
    },
  ): Promise<{
    matched: Array<ContextLexicalKey & {
      score: number;
      chunk_ordinal: number;
      start: number;
      end: number;
    }>;
    authorized_count: number;
    covered_count: number;
  }>;
  matchAuthorizedText?(input: {
    org_id: string;
    generation: string;
    authorized: ContextVectorAuthorizationKey[];
    authorization_hash?: string;
    authorization_accumulator?: string;
    authorization_delta?: ContextVectorAuthorizationDelta;
    query: string;
    limit: number;
    search_kind?: Exclude<import("./context-search").ContextSearchKind, "messages">;
  }): ReturnType<ContextVectorIndex["matchAuthorized"]>;
  registerGeneration(orgId: string, generation: EmbeddingGeneration): Promise<void>;
  matchAuthorized(input: {
    org_id: string;
    generation: string;
    authorized: ContextVectorAuthorizationKey[];
    authorization_hash?: string;
    authorization_accumulator?: string;
    authorization_delta?: ContextVectorAuthorizationDelta;
    query_vector: number[];
    limit: number;
    query?: string;
    search_kind?: import("./context-search").ContextSearchKind;
  }): Promise<{
    generation: string;
    covered: ContextLexicalKey[];
    coverage?: ContextVectorCoverageProof;
    acceleration?: ContextVectorAcceleration;
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
  started_at?: string;
  completed_at?: string;
  processing_ms: number;
  error_code?: string;
}

export interface EmbeddingJobSummary {
  counts: Record<EmbeddingJob["status"], number>;
  failures: Array<{ error_code: string; failed: number; quarantined: number }>;
  timing: {
    as_of: string;
    running_elapsed_ms?: number;
    recent_processing_ms?: number;
  };
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
    order?: "oldest" | "newest";
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
  summarizeJobs(orgId: string, generation: string, now?: string): Promise<EmbeddingJobSummary>;
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
  /**
   * True once after the last run stopped on the time or job budget with work
   * still queued. A pause or an empty queue does not ask for another pass.
   */
  wantsImmediateResume?(): boolean;
}
