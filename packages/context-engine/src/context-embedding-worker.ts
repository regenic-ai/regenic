import { createHash, randomUUID } from "node:crypto";
import {
  assertEmbeddingDescriptor,
  EmbeddingError,
  type AuthorizedContextSourceEvent,
  type ContextEmbeddingRunner,
  type ContextEvidenceSource,
  type ContextRequest,
  type ContextSourceRead,
  type ContextVectorChunk,
  type ContextVectorIndex,
  type ContextVectorGenerationStore,
  type EmbeddingGeneration,
  type EmbeddingJob,
  type EmbeddingJobStore,
  type EmbeddingProvider,
  type EmbeddingSourceHead,
} from "@regenic/domain";
import { ContextTextMaterialError } from "./authority-context-source";

const DEFAULT_RUN_MAX_JOBS = 16;
const DEFAULT_RUN_BUDGET_MS = 1_500;
const MAX_RUN_JOBS = 100;
const MAX_RUN_BUDGET_MS = 30_000;

type EmbeddingRunOptions = NonNullable<Parameters<ContextEmbeddingRunner["runOnce"]>[0]>;
type EmbeddingRunResult = Awaited<ReturnType<ContextEmbeddingRunner["runOnce"]>>;

export class ContextEmbeddingWorker implements ContextEmbeddingRunner {
  private readonly owner = `embedding:${randomUUID()}`;
  private abort = new AbortController();
  private stopped = false;
  private clearing = false;
  private running: ReturnType<ContextEmbeddingRunner["runOnce"]> | undefined;
  private generationCursor = 0;

  constructor(
    private readonly orgId: string,
    private readonly source: ContextEvidenceSource,
    private readonly provider: EmbeddingProvider,
    private readonly index: ContextVectorIndex,
    private readonly jobs: EmbeddingJobStore,
    readonly generation: EmbeddingGeneration,
    private readonly generations?: ContextVectorGenerationStore,
  ) {
    assertEmbeddingDescriptor(provider.descriptor, generation.model);
  }

  async runOnce(options: EmbeddingRunOptions = {}): ReturnType<ContextEmbeddingRunner["runOnce"]> {
    if (this.stopped || this.clearing || this.running) return { processed: 0, failed: 0, superseded: 0 };
    this.running = this.runGenerations(options);
    try {
      return await this.running;
    } finally {
      this.running = undefined;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    await this.running;
  }

  async clearProjection(): Promise<void> {
    if (this.clearing) throw new Error("Embedding projection clear is already running");
    this.clearing = true;
    this.abort.abort();
    try {
      await this.running;
      await this.index.clearOrganization(this.orgId);
    } finally {
      if (!this.stopped) this.abort = new AbortController();
      this.clearing = false;
    }
  }

  private async read(generation: EmbeddingGeneration): Promise<ContextSourceRead> {
    const request = embeddingMaintenanceRequest(this.orgId, this.owner);
    const read = await this.source.openRead(request);
    if (read.lifecycle_complete !== true) throw new Error("Embedding requires a complete authority lifecycle view");
    await this.jobs.reconcile({
      org_id: this.orgId, generation: generation.id, read_epoch: read.read_epoch,
      heads: headsFor(read), now: new Date().toISOString(),
    });
    return read;
  }

  private async runGenerations(options: EmbeddingRunOptions) {
    await this.index.registerGeneration(this.orgId, this.generation);
    const manifests = this.generations
      ? (await this.generations.listGenerations(this.orgId)).map((entry) => entry.manifest)
      : [this.generation];
    const maxJobs = boundedRunOption(options.max_jobs, DEFAULT_RUN_MAX_JOBS, 1, MAX_RUN_JOBS);
    const budgetMs = boundedRunOption(options.time_budget_ms, DEFAULT_RUN_BUDGET_MS, 1, MAX_RUN_BUDGET_MS);
    const deadline = Date.now() + budgetMs;
    const total: EmbeddingRunResult = { processed: 0, failed: 0, superseded: 0 };
    const reads = new Map<string, ContextSourceRead>();
    let attempted = 0;

    while (attempted < maxJobs && Date.now() < deadline && !this.abort.signal.aborted && !options.pause_if?.()) {
      let found = false;
      for (let offset = 0; offset < manifests.length; offset++) {
        const cursor = (this.generationCursor + offset) % manifests.length;
        const generation = manifests[cursor];
        assertEmbeddingDescriptor(this.provider.descriptor, generation.model);
        const run = await this.run(generation, reads.get(generation.id));
        reads.set(generation.id, run.read);
        if (run.claimed) {
          found = true;
          attempted += 1;
          total.processed += run.result.processed;
          total.failed += run.result.failed;
          total.superseded += run.result.superseded;
          this.generationCursor = (cursor + 1) % manifests.length;
          break;
        }
      }
      if (!found) break;
    }
    return total;
  }

  private async run(generation: EmbeddingGeneration, previous?: ContextSourceRead) {
    let read = previous ?? await this.read(generation);
    const claimed = await this.jobs.claim({
      org_id: this.orgId, generation: generation.id, owner: this.owner,
      now: new Date().toISOString(), lease_ms: 90000, limit: 1,
    });
    const result = { processed: 0, failed: 0, superseded: 0 };
    if (claimed.length === 0) return { claimed: false, read, result };
    for (const job of claimed) {
      if (this.abort.signal.aborted) break;
      let leaseLost = false;
      let heartbeatFailed = false;
      let heartbeat = Promise.resolve();
      const timer = setInterval(() => {
        heartbeat = heartbeat.then(async () => {
          if (!await this.jobs.renew(job, this.owner, new Date().toISOString(), 90000)) leaseLost = true;
        }).catch(() => { leaseLost = true; heartbeatFailed = true; });
      }, 20000);
      try {
        const event = read.events.find((event) => event.event.event_id === job.event_id);
        if (!event || !isHead(read, job)) {
          result.superseded += 1;
          continue;
        }
        const authorized: AuthorizedContextSourceEvent = { ...event, status: "current" };
        const materialized = this.source.materialize
          ? await this.source.materialize([authorized])
          : [authorized];
        const text = materialized[0]?.text;
        if (typeof text !== "string" || !text.trim()) throw new EmbeddingError("invalid_input", false);
        if (Buffer.byteLength(text, "utf8") > 262144) throw new EmbeddingError("input_too_large", false);
        const chunks = await chunkEmbeddingText(text, this.provider, generation, this.abort.signal);
        read = await this.read(generation);
        await heartbeat;
        if (heartbeatFailed) throw new Error("Embedding lease renewal failed");
        if (leaseLost || !isHead(read, job)) {
          result.superseded += 1;
          continue;
        }
        const completed = await this.jobs.complete({
          job, owner: this.owner, now: new Date().toISOString(), chunks,
        });
        if (completed) result.processed += 1;
        else result.superseded += 1;
      } catch (error) {
        const code = error instanceof EmbeddingError ? error.code
          : error instanceof ContextTextMaterialError ? "invalid_input" : "indexing_failed";
        const retryable = error instanceof ContextTextMaterialError ? false
          : !(error instanceof EmbeddingError) || error.retryable;
        const now = new Date();
        const delay = Math.min(300000, 1000 * 2 ** Math.min(job.attempts, 8));
        await this.jobs.fail({
          job, owner: this.owner, now: now.toISOString(),
          retry_at: new Date(now.getTime() + delay + Math.floor(Math.random() * 1000)).toISOString(),
          error_code: code, retryable,
        });
        result.failed += 1;
      } finally {
        clearInterval(timer);
        await heartbeat;
      }
    }
    return { claimed: true, read, result };
  }
}

function boundedRunOption(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`Embedding run option must be an integer between ${min} and ${max}`);
  }
  return value;
}

export async function activateEmbeddingGeneration(
  orgId: string,
  generation: string,
  source: ContextEvidenceSource,
  jobs: EmbeddingJobStore,
  generations: ContextVectorGenerationStore,
): Promise<void> {
  const request = embeddingMaintenanceRequest(orgId, `generation-switch:${randomUUID()}`);
  const read = await source.openRead(request);
  if (read.lifecycle_complete !== true) throw new Error("Generation activation requires a complete Authority lifecycle");
  const heads = headsFor(read);
  await jobs.reconcile({
    org_id: orgId, generation, read_epoch: read.read_epoch, heads, now: new Date().toISOString(),
  });
  const ids = new Set(heads.filter((head) => head.operation !== "tombstone").map((head) => head.event_id));
  const current: AuthorizedContextSourceEvent[] = read.events.filter((entry) => ids.has(entry.event.event_id))
    .map((entry) => ({ ...entry, status: "current" }));
  if (!source.materialize) throw new Error("Generation activation requires verified Authority text materialization");
  const materialized = await source.materialize(current);
  const required = materialized.filter((entry) => typeof entry.text === "string" && entry.text.trim())
    .map((entry) => {
      if (!entry.event.content_hash) throw new Error("Text Event is missing its content hash");
      return { event_id: entry.event.event_id, content_hash: entry.event.content_hash };
    });
  const latest = await source.openRead(request);
  if (latest.read_epoch !== read.read_epoch) throw new Error("Authority changed during activation; retry after reconciliation");
  await generations.activateGeneration({ org_id: orgId, generation, read_epoch: read.read_epoch, required });
}

function embeddingMaintenanceRequest(orgId: string, id: string): ContextRequest {
  return {
    schema_version: "1.0", id, org_id: orgId,
    principal: { actor_type: "human", actor_id: orgId },
    consumer_id: "embedding-indexer", purpose: "maintain personal text projection", allowed_uses: ["display"],
    temporal: { mode: "current" },
    budget: { profile: "embedding-v1", max_tokens: 1, max_items: 1, max_raw_evidence: 1 },
  };
}

export async function chunkEmbeddingText(
  text: string,
  provider: EmbeddingProvider,
  generation: EmbeddingGeneration,
  signal?: AbortSignal,
): Promise<ContextVectorChunk[]> {
  const characters = Array.from(text);
  const chunks: ContextVectorChunk[] = [];
  const [wholeTokens] = await provider.countTokens([text], "document", signal);
  if (!Number.isSafeInteger(wholeTokens) || wholeTokens < 1) {
    throw new EmbeddingError("invalid_response", true);
  }
  if (wholeTokens <= generation.chunk_tokens) {
    const vectors = await provider.embed([text], "document", signal);
    if (vectors.length !== 1) throw new EmbeddingError("invalid_response", true);
    return [{
      ordinal: 0, start: 0, end: text.length,
      text_hash: createHash("sha256").update(text).digest("hex"), vector: vectors[0],
    }];
  }
  let offset = 0;
  let start = 0;
  while (offset < characters.length) {
    if (signal?.aborted) throw new EmbeddingError("cancelled", true);
    if (chunks.length >= generation.max_chunks_per_event) throw new EmbeddingError("input_too_large", false);
    let low = 1;
    let high = characters.length - offset;
    let length = 0;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const slice = characters.slice(offset, offset + middle).join("");
      const [count] = await provider.countTokens([slice], "document", signal);
      if (!Number.isSafeInteger(count) || count < 1) throw new EmbeddingError("invalid_response", true);
      if (count <= generation.chunk_tokens) { length = middle; low = middle + 1; }
      else high = middle - 1;
    }
    if (length === 0) throw new EmbeddingError("input_too_large", false);
    let slice = characters.slice(offset, offset + length).join("");
    const fittingSlice = slice;
    if (offset + length < characters.length) {
      const boundary = Math.max(slice.lastIndexOf("\n"), slice.lastIndexOf("。"), slice.lastIndexOf("！"), slice.lastIndexOf("？"));
      if (boundary > slice.length / 2) {
        slice = slice.slice(0, boundary + 1);
        length = Array.from(slice).length;
      }
    }
    let [tokens] = await provider.countTokens([slice], "document", signal);
    if (tokens > generation.chunk_tokens && slice !== fittingSlice) {
      // Removing a tokenizer merge at a preferred boundary can increase the count.
      slice = fittingSlice;
      length = Array.from(slice).length;
      [tokens] = await provider.countTokens([slice], "document", signal);
    }
    if (!Number.isSafeInteger(tokens) || tokens < 1 || tokens > generation.chunk_tokens) throw new EmbeddingError("invalid_response", true);
    const vectors = await provider.embed([slice], "document", signal);
    if (vectors.length !== 1) throw new EmbeddingError("invalid_response", true);
    chunks.push({
      ordinal: chunks.length, start, end: start + slice.length,
      text_hash: createHash("sha256").update(slice).digest("hex"), vector: vectors[0],
    });
    offset += length;
    start += slice.length;
  }
  return chunks;
}

function isHead(read: ContextSourceRead, job: EmbeddingJob): boolean {
  return read.lifecycle_heads.some((head) =>
    head.source === job.source && head.external_id === job.external_id && head.head_event_id === job.event_id,
  );
}

function headsFor(read: ContextSourceRead): EmbeddingSourceHead[] {
  const byId = new Map(read.events.map((event) => [event.event.event_id, event.event]));
  return read.lifecycle_heads.map((head) => {
    const event = byId.get(head.head_event_id);
    if (!event) throw new Error("Embedding lifecycle head is missing");
    const lineage: string[] = [];
    let current: typeof event | undefined = event;
    while (current) {
      if (lineage.includes(current.event_id)) throw new Error("Embedding lifecycle is cyclic");
      lineage.push(current.event_id);
      current = current.parent_event_id ? byId.get(current.parent_event_id) : undefined;
    }
    return {
      source: event.source, external_id: event.external_id, event_id: event.event_id,
      operation: event.operation, lineage: lineage.reverse(),
      ...(event.content_hash ? { content_hash: event.content_hash } : {}),
    };
  });
}
