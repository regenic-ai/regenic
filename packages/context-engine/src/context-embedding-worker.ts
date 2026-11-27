import { createHash, randomUUID } from "node:crypto";
import {
  assertEmbeddingDescriptor,
  EmbeddingError,
  EmbeddingGenerationNotReadyError,
  type AuthorizedContextSourceEvent,
  type ContextEmbeddingRunner,
  type ContextEvidenceSource,
  type ContextRequest,
  type ContextSourceEvent,
  type ContextSourceRead,
  type ContextEmbeddingMaterial,
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
const CHECKPOINT_BATCH_CHUNKS = 8;
const EMBED_BATCH = CHECKPOINT_BATCH_CHUNKS;
const DOCUMENT_GROUP = 4;

type AuthoritySnapshot = { read: ContextSourceRead; stamp?: string };
type PreparedPlain = { job: EmbeddingJob; text: string; material: ContextEmbeddingMaterial };

class EmbeddingBatchYield extends Error {}

type EmbeddingRunOptions = NonNullable<Parameters<ContextEmbeddingRunner["runOnce"]>[0]>;
type EmbeddingRunResult = Awaited<ReturnType<ContextEmbeddingRunner["runOnce"]>>;

export class ContextEmbeddingWorker implements ContextEmbeddingRunner {
  private readonly owner = `embedding:${randomUUID()}`;
  private abort = new AbortController();
  private stopped = false;
  private clearing = false;
  private running: ReturnType<ContextEmbeddingRunner["runOnce"]> | undefined;
  private generationCursor = 0;
  private continueImmediately = false;
  private headsRemain = false;
  private readonly claimSequences = new Map<string, number>();

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
    this.continueImmediately = false;
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

  wantsImmediateResume(): boolean {
    const resume = this.continueImmediately;
    this.continueImmediately = false;
    return resume;
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

  private async openAuthorityRead(): Promise<ContextSourceRead> {
    const request = embeddingMaintenanceRequest(this.orgId, this.owner);
    const read = await this.source.openRead(request);
    if (read.lifecycle_complete !== true) throw new Error("Embedding requires a complete authority lifecycle view");
    return read;
  }

  private async reconcileRead(read: ContextSourceRead, generation: EmbeddingGeneration): Promise<void> {
    await this.jobs.reconcile({
      org_id: this.orgId,
      generation: generation.id,
      read_epoch: read.read_epoch,
      heads: headsFor(read),
      now: new Date().toISOString(),
    });
  }

  private async read(generation: EmbeddingGeneration): Promise<ContextSourceRead> {
    const read = await this.openAuthorityRead();
    await this.reconcileRead(read, generation);
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
    this.headsRemain = false;
    const total: EmbeddingRunResult = { processed: 0, failed: 0, superseded: 0 };
    const reads = new Map<string, AuthoritySnapshot>();
    let attempted = 0;

    work: while (attempted < maxJobs && Date.now() < deadline && !this.abort.signal.aborted && !options.pause_if?.()) {
      let found = false;
      for (let offset = 0; offset < manifests.length; offset++) {
        const cursor = (this.generationCursor + offset) % manifests.length;
        const generation = manifests[cursor];
        assertEmbeddingDescriptor(this.provider.descriptor, generation.model);
        const run = await this.run(
          generation, reads.get(generation.id), options.pause_if, deadline, maxJobs - attempted,
        );
        reads.set(generation.id, { read: run.read, stamp: run.stamp });
        if (run.claimedCount > 0) {
          found = true;
          attempted += run.claimedCount;
          total.processed += run.result.processed;
          total.failed += run.result.failed;
          total.superseded += run.result.superseded;
          this.generationCursor = (cursor + 1) % manifests.length;
          if (run.yielded) break work;
          break;
        }
      }
      if (!found) break;
    }
    const paused = options.pause_if?.() === true;
    this.continueImmediately = !this.abort.signal.aborted && !paused &&
      (this.headsRemain || Date.now() >= deadline || attempted >= maxJobs);
    if (this.generations && !this.abort.signal.aborted && reads.has(this.generation.id) &&
      this.generation.extractor_version === "stored-body-and-attachments-v2") {
      const entries = await this.generations.listGenerations(this.orgId);
      const target = entries.find((entry) => entry.manifest.id === this.generation.id);
      const active = entries.find((entry) => entry.active);
      if (target?.previously_active === false &&
        (active?.manifest.extractor_version === "stored-body-text-v1" ||
          (active?.manifest.extractor_version === this.generation.extractor_version &&
            active.manifest.max_chunks_per_event < this.generation.max_chunks_per_event &&
            active.manifest.chunk_tokens === this.generation.chunk_tokens))) {
        const jobs = await this.jobs.listJobs(this.orgId, this.generation.id);
        if (jobs.every((job) => ["succeeded", "skipped", "superseded"].includes(job.status))) {
          try {
            await activateEmbeddingGeneration(
              this.orgId, this.generation.id, this.source, this.jobs, this.generations,
            );
          } catch (error) {
            if (!(error instanceof EmbeddingGenerationNotReadyError)) throw error;
            console.warn("Embedding generation upgrade deferred", error.reason);
          }
        }
      }
    }
    return total;
  }

  private async run(
    generation: EmbeddingGeneration,
    previous: AuthoritySnapshot | undefined,
    pause: (() => boolean) | undefined,
    deadline: number,
    slots: number,
  ) {
    const snapshot: AuthoritySnapshot = previous
      ? { read: previous.read, stamp: previous.stamp }
      : await this.loadSnapshot(generation);
    const result = { processed: 0, failed: 0, superseded: 0 };
    let yielded = false;
    const room = Math.min(DOCUMENT_GROUP, Math.max(0, slots));
    let sequence = this.claimSequences.get(generation.id) ?? 0;
    let claimedCount = 0;
    const plain: PreparedPlain[] = [];
    let blocked: EmbeddingJob | undefined;
    while (claimedCount < room && !blocked && !this.abort.signal.aborted && Date.now() < deadline) {
      if (claimedCount > 0 && pause?.()) break;
      const [job] = await this.jobs.claim({
        org_id: this.orgId, generation: generation.id, owner: this.owner,
        now: new Date().toISOString(), lease_ms: 90000, limit: 1,
        order: sequence % 4 === 3 ? "oldest" : "newest",
      });
      if (!job) break;
      sequence += 1;
      this.claimSequences.set(generation.id, sequence);
      claimedCount += 1;
      try {
        const prepared = await this.preparePlain(job, snapshot, generation);
        if (prepared === "superseded") {
          result.superseded += 1;
          continue;
        }
        if (prepared === "other") {
          blocked = job;
          break;
        }
        plain.push(prepared);
      } catch (error) {
        await this.failClaimed(job, error);
        result.failed += 1;
        break;
      }
    }
    if (claimedCount === 0) return { claimedCount, read: snapshot.read, stamp: snapshot.stamp, result, yielded };
    if (plain.length > 0) {
      yielded = await this.indexPlainGroup(plain, generation, snapshot, pause, deadline, result);
    }
    if (blocked) {
      if (yielded || this.abort.signal.aborted || Date.now() >= deadline) {
        if (!await this.jobs.yieldJob(blocked, this.owner, new Date().toISOString())) result.superseded += 1;
        yielded = true;
      } else {
        yielded = await this.indexClaimedJob(blocked, generation, snapshot, pause, deadline, result) || yielded;
      }
    }
    return { claimedCount, read: snapshot.read, stamp: snapshot.stamp, result, yielded };
  }

  private async indexClaimedJob(
    job: EmbeddingJob,
    generation: EmbeddingGeneration,
    snapshot: AuthoritySnapshot,
    pause: (() => boolean) | undefined,
    deadline: number,
    result: { processed: number; failed: number; superseded: number },
  ): Promise<boolean> {
    {
      if (this.abort.signal.aborted) return false;
      let leaseLost = false;
      let heartbeatFailed = false;
      let heartbeat = Promise.resolve();
      const timer = setInterval(() => {
        heartbeat = heartbeat.then(async () => {
          if (!await this.jobs.renew(job, this.owner, new Date().toISOString(), 90000)) leaseLost = true;
        }).catch(() => { leaseLost = true; heartbeatFailed = true; });
      }, 20000);
      try {
        const event = await this.stillCurrent(job, snapshot.read);
        if (!event) {
          result.superseded += 1;
          return false;
        }
        const authorized: AuthorizedContextSourceEvent = { ...event, status: "current" };
        const material = this.source.materializeForEmbedding
          ? (await this.source.materializeForEmbedding([authorized], generation.extractor_version))[0]
          : undefined;
        if (this.source.materializeForEmbedding &&
          (!material || material.event_id !== job.event_id || !Array.isArray(material.attachments))) {
          throw new EmbeddingError("invalid_response", true);
        }
        const textMaterial = material ? undefined : this.source.materialize
          ? (await this.source.materialize([authorized]))[0]
          : authorized;
        const text = material?.text ?? textMaterial?.text;
        if (typeof text === "string" && Buffer.byteLength(text, "utf8") > 262144) {
          throw new EmbeddingError("input_too_large", false);
        }
        let chunks: ContextVectorChunk[] = [];
        const staged = await this.jobs.loadStagedChunks(job, this.owner, new Date().toISOString());
        let freshChunks = 0;
        const saveChunk = async (chunk: ContextVectorChunk) => {
          if (chunk.ordinal >= generation.max_chunks_per_event) throw new EmbeddingError("input_too_large", false);
          if (!await this.jobs.stageChunk({
            job, owner: this.owner, now: new Date().toISOString(), chunk,
          })) throw new Error("Embedding checkpoint lease lost");
          freshChunks++;
          if (freshChunks < CHECKPOINT_BATCH_CHUNKS) return;
          freshChunks = 0;
          if (this.abort.signal.aborted || pause?.() || Date.now() >= deadline) throw new EmbeddingBatchYield();
        };
        const appendText = async (
          value: string,
          origin?: { part_index: number; content_hash: string },
        ) => {
          const start = chunks.at(-1)?.end ?? 0;
          const ordinal = chunks.length;
          const bind = (chunk: ContextVectorChunk): ContextVectorChunk => {
            const part = !origin ? material?.search_parts?.find((part) =>
              part.content_hash && part.projection_start !== undefined && part.text !== undefined &&
              chunk.start >= part.projection_start && chunk.end <= part.projection_start + part.text.length,
            ) : undefined;
            const binding = origin ?? (part?.content_hash ? {
              part_index: part.part_index, content_hash: part.content_hash,
            } : undefined);
            return {
              ...chunk, ordinal: ordinal + chunk.ordinal, start: start + chunk.start, end: start + chunk.end,
              ...(binding ? { origin: {
                ...binding, mode: "text" as const, start: chunk.start - (part?.projection_start ?? 0),
                text: value.slice(chunk.start, chunk.end),
              } } : {}),
            };
          };
          const textChunks = staged.slice(ordinal).filter((chunk) =>
            chunk.start >= start && chunk.end <= start + value.length,
          ).map((chunk, index) => ({
            ...chunk, ordinal: index, start: chunk.start - start, end: chunk.end - start,
          }));
          const extracted = await chunkEmbeddingText(value, this.provider, {
            ...generation, max_chunks_per_event: generation.max_chunks_per_event - ordinal,
          }, this.abort.signal, {
            chunks: textChunks,
            save: (chunk) => saveChunk(bind(chunk)),
            room: () => Math.max(0, CHECKPOINT_BATCH_CHUNKS - freshChunks),
          });
          chunks.push(...extracted.map(bind));
        };
        if (typeof text === "string" && text.trim()) {
          await appendText(text);
        }
        if (material?.attachments.length) {
          if (!this.provider.processAttachment) throw new EmbeddingError("unavailable", true);
          for (const attachment of material.attachments) {
            const processed = await this.provider.processAttachment({
              media_type: attachment.media_type,
              ...(attachment.source_filename ? { source_filename: attachment.source_filename } : {}),
              bytes: attachment.bytes,
            }, this.abort.signal);
            if (!processed.text?.trim() && processed.vectors.length === 0 &&
              !(processed.skipped_visual === true && this.provider.visualEnabled === false)) {
              throw new EmbeddingError("invalid_response", true);
            }
            if (processed.text?.trim()) {
              if (Buffer.byteLength(processed.text, "utf8") > 262144) {
                throw new EmbeddingError("input_too_large", false);
              }
              await appendText(processed.text, attachment.part_index === undefined ? undefined : {
                part_index: attachment.part_index, content_hash: attachment.content_hash,
              });
            }
            if (this.provider.visualEnabled === false && processed.vectors.length > 0) {
              throw new EmbeddingError("invalid_response", false);
            }
            for (const [index, vector] of processed.vectors.entries()) {
              const cursor = chunks.length ? chunks[chunks.length - 1].end : 0;
              const chunk = {
                ordinal: chunks.length,
                start: cursor,
                end: cursor + 1,
                text_hash: createHash("sha256")
                  .update(`${attachment.content_hash}:${index}`)
                  .digest("hex"),
                vector,
                ...(attachment.part_index === undefined ? {} : { origin: {
                  part_index: attachment.part_index, content_hash: attachment.content_hash,
                  mode: "visual" as const, start: index,
                } }),
              };
              const saved = staged[chunk.ordinal];
              if (saved) {
                if (saved.text_hash !== chunk.text_hash || saved.start !== chunk.start || saved.end !== chunk.end) {
                  throw new Error("Embedding checkpoint content mismatch");
                }
                chunks.push({ ...saved, ...(chunk.origin ? { origin: chunk.origin } : {}) });
              } else {
                await saveChunk(chunk);
                chunks.push(chunk);
              }
            }
            if (chunks.length > generation.max_chunks_per_event) {
              throw new EmbeddingError("input_too_large", false);
            }
          }
        }
        const noContent = chunks.length === 0 &&
          (!material?.attachments.length || this.provider.visualEnabled === false) &&
          generation.extractor_version === "stored-body-and-attachments-v2";
        if (staged.length > chunks.length) throw new Error("Embedding checkpoint content mismatch");
        if (chunks.length === 0 && !noContent) throw new EmbeddingError("invalid_input", false);
        const confirmed = await this.confirmAuthority(snapshot.read, snapshot.stamp, generation, pause);
        snapshot.read = confirmed.read;
        snapshot.stamp = confirmed.stamp;
        await heartbeat;
        if (heartbeatFailed) throw new Error("Embedding lease renewal failed");
        if (leaseLost || !await this.stillCurrent(job, snapshot.read)) {
          result.superseded += 1;
          return false;
        }
        const completed = await this.jobs.complete({
          job, owner: this.owner, now: new Date().toISOString(), chunks,
          ...(noContent ? { no_content: true } : {}),
        });
        if (completed) result.processed += 1;
        else result.superseded += 1;
        return false;
      } catch (error) {
        if (error instanceof EmbeddingBatchYield) {
          if (!await this.jobs.yieldJob(job, this.owner, new Date().toISOString())) result.superseded += 1;
          return true;
        }
        await this.failClaimed(job, error);
        result.failed += 1;
        return false;
      } finally {
        clearInterval(timer);
        await heartbeat;
      }
    }
  }

  private async loadSnapshot(generation: EmbeddingGeneration): Promise<AuthoritySnapshot> {
    const before = await this.captureStamp();
    if (this.jobs.reconcileChanged && this.authorityPath()) {
      await this.drainChangedHeads(generation, 8);
      const after = await this.captureStamp();
      return {
        read: {
          read_epoch: `authorized-stamp:${before ?? "open"}`,
          recorded_at: new Date().toISOString(),
          lifecycle_complete: true,
          lifecycle_heads: [],
          events: [],
        },
        stamp: before !== undefined && before === after ? after : undefined,
      };
    }
    const read = await this.read(generation);
    const after = await this.captureStamp();
    return { read, stamp: before !== undefined && before === after ? after : undefined };
  }

  private async captureStamp(): Promise<string | undefined> {
    if (!this.source.openReadStamp) return undefined;
    return this.source.openReadStamp();
  }

  private authorityPath(): string | undefined {
    const path = this.source.databasePath?.();
    if (!path || path === ":memory:" || path.includes("\0")) return undefined;
    return path;
  }

  /** Pages authority events after the stored sequence. Already indexed heads are not scanned again. */
  private async drainChangedHeads(generation: EmbeddingGeneration, pages: number): Promise<void> {
    const path = this.authorityPath();
    if (!path || !this.jobs.reconcileChanged) return;
    for (let index = 0; index < pages; index += 1) {
      if (this.abort.signal.aborted) return;
      const stamp = await this.captureStamp();
      const page = await this.jobs.reconcileChanged({
        org_id: this.orgId,
        generation: generation.id,
        authority_path: path,
        read_epoch: `authorized-stamp:${stamp ?? "open"}`,
        now: new Date().toISOString(),
        limit: 200,
      });
      if (page.done) {
        this.headsRemain = false;
        return;
      }
      this.headsRemain = true;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  private async stillCurrent(job: EmbeddingJob, read: ContextSourceRead): Promise<ContextSourceEvent | undefined> {
    if (this.authorityPath() && this.source.loadCurrentEvents) {
      const loaded = await this.source.loadCurrentEvents(this.orgId, [job.event_id]);
      const event = loaded.find((entry) => entry.event.event_id === job.event_id);
      if (!event || event.event.source !== job.source || event.event.external_id !== job.external_id) return undefined;
      if (job.content_hash && event.event.content_hash !== job.content_hash) return undefined;
      return event;
    }
    const event = read.events.find((entry) => entry.event.event_id === job.event_id);
    if (!event || !isHead(read, job)) return undefined;
    return event;
  }

  private async confirmAuthority(
    read: ContextSourceRead,
    stamp: string | undefined,
    generation: EmbeddingGeneration,
    pause: (() => boolean) | undefined,
  ): Promise<AuthoritySnapshot> {
    const current = await this.captureStamp();
    if (stamp !== undefined && current === stamp) return { read, stamp };
    const paused = pause?.() === true;
    if (this.jobs.reconcileChanged && this.authorityPath()) {
      if (!paused) await this.drainChangedHeads(generation, 1);
      const after = await this.captureStamp();
      return { read, stamp: !paused && after === current ? after : undefined };
    }
    const fresh = await this.openAuthorityRead();
    if (!paused) await this.reconcileRead(fresh, generation);
    const after = await this.captureStamp();
    return { read: fresh, stamp: !paused && after === current ? after : undefined };
  }

  private async preparePlain(
    job: EmbeddingJob,
    snapshot: AuthoritySnapshot,
    generation: EmbeddingGeneration,
  ): Promise<PreparedPlain | "other" | "superseded"> {
    const event = await this.stillCurrent(job, snapshot.read);
    if (!event) return "superseded";
    if (!this.source.materializeForEmbedding) return "other";
    const authorized: AuthorizedContextSourceEvent = { ...event, status: "current" };
    const material = (await this.source.materializeForEmbedding(
      [authorized], generation.extractor_version,
    ))[0];
    if (!material || material.event_id !== job.event_id || !Array.isArray(material.attachments)) {
      throw new EmbeddingError("invalid_response", true);
    }
    const text = material.text;
    if (material.attachments.length > 0 || typeof text !== "string" || !text.trim()) return "other";
    if (Buffer.byteLength(text, "utf8") > 262144) throw new EmbeddingError("input_too_large", false);
    if ((await this.jobs.loadStagedChunks(job, this.owner, new Date().toISOString())).length > 0) return "other";
    return { job, text, material };
  }

  private async failClaimed(job: EmbeddingJob, error: unknown): Promise<void> {
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
  }

  private async indexPlainGroup(
    items: PreparedPlain[],
    generation: EmbeddingGeneration,
    snapshot: AuthoritySnapshot,
    pause: (() => boolean) | undefined,
    deadline: number,
    result: { processed: number; failed: number; superseded: number },
  ): Promise<boolean> {
    let counts: number[];
    try {
      counts = await this.provider.countTokens(
        items.map((item) => item.text), "document", this.abort.signal,
      );
    } catch (error) {
      for (const item of items) {
        await this.failClaimed(item.job, error);
        result.failed += 1;
      }
      return false;
    }
    if (counts.length !== items.length || counts.some((count) => !Number.isSafeInteger(count) || count < 1)) {
      const error = new EmbeddingError("invalid_response", true);
      for (const item of items) {
        await this.failClaimed(item.job, error);
        result.failed += 1;
      }
      return false;
    }
    const shorts: PreparedPlain[] = [];
    const longs: EmbeddingJob[] = [];
    items.forEach((item, index) => {
      if (counts[index] <= generation.chunk_tokens) shorts.push(item);
      else longs.push(item.job);
    });
    if (shorts.length > 0) {
      let vectors: number[][] | undefined;
      try {
        vectors = await this.provider.embed(
          shorts.map((item) => item.text), "document", this.abort.signal,
        );
        if (vectors.length !== shorts.length) throw new EmbeddingError("invalid_response", true);
      } catch (error) {
        for (const item of shorts) {
          await this.failClaimed(item.job, error);
          result.failed += 1;
        }
        vectors = undefined;
      }
      if (vectors) {
        const ready: Array<{ item: PreparedPlain; chunks: ContextVectorChunk[] }> = [];
        for (let index = 0; index < shorts.length; index += 1) {
          try {
            ready.push({
              item: shorts[index],
              chunks: await this.stagePlainChunk(shorts[index], vectors[index], generation),
            });
          } catch (error) {
            await this.failClaimed(shorts[index].job, error);
            result.failed += 1;
          }
        }
        if (ready.length > 0) {
          const confirmed = await this.confirmAuthority(snapshot.read, snapshot.stamp, generation, pause);
          snapshot.read = confirmed.read;
          snapshot.stamp = confirmed.stamp;
          for (const entry of ready) {
            if (!await this.stillCurrent(entry.item.job, snapshot.read)) {
              result.superseded += 1;
              continue;
            }
            const completed = await this.jobs.complete({
              job: entry.item.job, owner: this.owner, now: new Date().toISOString(), chunks: entry.chunks,
            });
            if (completed) result.processed += 1;
            else result.superseded += 1;
          }
        }
      }
    }
    let yielded = false;
    for (const job of longs) {
      if (yielded || this.abort.signal.aborted || Date.now() >= deadline || pause?.()) {
        if (!await this.jobs.yieldJob(job, this.owner, new Date().toISOString())) result.superseded += 1;
        yielded = true;
        continue;
      }
      if (await this.indexClaimedJob(job, generation, snapshot, pause, deadline, result)) yielded = true;
    }
    return yielded;
  }

  private async stagePlainChunk(
    item: PreparedPlain,
    vector: number[],
    generation: EmbeddingGeneration,
  ): Promise<ContextVectorChunk[]> {
    const text = item.text;
    const staged: ContextVectorChunk[] = [];
    const provider: EmbeddingProvider = {
      descriptor: this.provider.descriptor,
      visualEnabled: this.provider.visualEnabled,
      async countTokens() { throw new EmbeddingError("unavailable", true); },
      async planChunks(value: string, _chunkTokens: number, maxChunks: number) {
        if (value !== text || maxChunks < 1) throw new EmbeddingError("invalid_response", true);
        return [text];
      },
      async embed(values: string[]) {
        if (values.length !== 1 || values[0] !== text) throw new EmbeddingError("invalid_response", true);
        return [vector];
      },
      async health() { return { status: "ok" }; },
    };
    await chunkEmbeddingText(text, provider, generation, this.abort.signal, {
      chunks: [],
      save: async (chunk) => {
        const bound = bindPlainChunk(chunk, text, item.material);
        if (!await this.jobs.stageChunk({
          job: item.job, owner: this.owner, now: new Date().toISOString(), chunk: bound,
        })) throw new Error("Embedding checkpoint lease lost");
        staged.push(bound);
      },
    });
    if (staged.length !== 1 || staged[0].start !== 0 || staged[0].end !== text.length) {
      throw new EmbeddingError("invalid_response", true);
    }
    return staged;
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
  const manifest = (await generations.listGenerations(orgId))
    .find((entry) => entry.manifest.id === generation)?.manifest;
  if (!manifest) throw new Error("Generation activation requires a registered generation");
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
  const required = source.materializeForEmbedding
    ? (await source.materializeForEmbedding(current, manifest.extractor_version))
      .filter((entry) => Boolean(entry.text?.trim()) || entry.attachments.length > 0)
      .map((entry) => {
        const event = current.find((sourceEvent) => sourceEvent.event.event_id === entry.event_id)!;
        if (!event.event.content_hash) throw new Error("Indexable Event is missing its content hash");
        return { event_id: entry.event_id, content_hash: event.event.content_hash };
      })
    : (await source.materialize(current))
      .filter((entry) => typeof entry.text === "string" && entry.text.trim())
      .map((entry) => {
        if (!entry.event.content_hash) throw new Error("Text Event is missing its content hash");
        return { event_id: entry.event.event_id, content_hash: entry.event.content_hash };
      });
  const latest = await source.openRead(request);
  if (latest.read_epoch !== read.read_epoch) throw new EmbeddingGenerationNotReadyError("authority_changed");
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
  checkpoint?: {
    chunks: ContextVectorChunk[];
    save(chunk: ContextVectorChunk): Promise<void>;
    room?(): number;
  },
): Promise<ContextVectorChunk[]> {
  const chunks: ContextVectorChunk[] = checkpoint?.chunks.map((chunk) => ({ ...chunk })) ?? [];
  let start = 0;
  for (const [ordinal, chunk] of chunks.entries()) {
    if (chunk.ordinal !== ordinal || chunk.start !== start || !Number.isSafeInteger(chunk.end) ||
      chunk.end <= start || chunk.end > text.length ||
      chunk.text_hash !== createHash("sha256").update(text.slice(chunk.start, chunk.end)).digest("hex")) {
      throw new Error("Embedding checkpoint content mismatch");
    }
    start = chunk.end;
  }
  if (chunks.length > generation.max_chunks_per_event) throw new EmbeddingError("input_too_large", false);
  if (start === text.length) return chunks;
  const pending: Array<{ slice: string; start: number; end: number }> = [];
  const flush = async (): Promise<void> => {
    if (pending.length === 0) return;
    if (signal?.aborted) throw new EmbeddingError("cancelled", true);
    const batch = pending.splice(0, pending.length);
    const vectors = await provider.embed(batch.map((item) => item.slice), "document", signal);
    if (vectors.length !== batch.length) throw new EmbeddingError("invalid_response", true);
    for (let index = 0; index < batch.length; index += 1) {
      const item = batch[index];
      const chunk = {
        ordinal: chunks.length, start: item.start, end: item.end,
        text_hash: createHash("sha256").update(item.slice).digest("hex"), vector: vectors[index],
      };
      await checkpoint?.save(chunk);
      chunks.push(chunk);
    }
  };
  const batchSize = (): number => {
    const room = checkpoint?.room?.() ?? EMBED_BATCH;
    return Math.max(1, Math.min(EMBED_BATCH, room));
  };
  const queue = async (slice: string, sliceStart: number): Promise<void> => {
    pending.push({ slice, start: sliceStart, end: sliceStart + slice.length });
    if (pending.length >= batchSize()) await flush();
  };
  if (provider.planChunks) {
    const room = generation.max_chunks_per_event - chunks.length;
    if (room < 1) throw new EmbeddingError("input_too_large", false);
    let slices: string[] | undefined;
    try {
      slices = await provider.planChunks(text.slice(start), generation.chunk_tokens, room, signal);
    } catch (error) {
      // An older loopback server has no /chunks route. Keep indexing with local probes.
      if (!(error instanceof EmbeddingError) || error.code !== "unavailable") throw error;
    }
    if (slices) {
      if (!Array.isArray(slices) || slices.length < 1 || slices.length > room ||
        slices.some((slice) => typeof slice !== "string" || slice.length < 1) ||
        slices.join("") !== text.slice(start)) {
        throw new EmbeddingError("invalid_response", true);
      }
      for (const slice of slices) {
        if (signal?.aborted) throw new EmbeddingError("cancelled", true);
        if (chunks.length + pending.length >= generation.max_chunks_per_event) {
          throw new EmbeddingError("input_too_large", false);
        }
        await queue(slice, start);
        start += slice.length;
      }
      await flush();
      return chunks;
    }
  }
  const countSlice = async (slice: string): Promise<number> => {
    const [count] = await provider.countTokens([slice], "document", signal);
    if (!Number.isSafeInteger(count) || count < 1) throw new EmbeddingError("invalid_response", true);
    return count;
  };
  const characters = Array.from(text.slice(start));
  if (chunks.length === 0) {
    const wholeTokens = await countSlice(text);
    if (wholeTokens <= generation.chunk_tokens) {
      if (generation.max_chunks_per_event < 1) throw new EmbeddingError("input_too_large", false);
      await queue(text, 0);
      await flush();
      return chunks;
    }
  }
  let offset = 0;
  while (offset < characters.length) {
    if (signal?.aborted) throw new EmbeddingError("cancelled", true);
    if (chunks.length + pending.length >= generation.max_chunks_per_event) throw new EmbeddingError("input_too_large", false);
    const length = await fittingPrefixLength(characters, offset, generation.chunk_tokens, countSlice);
    if (length === 0) throw new EmbeddingError("input_too_large", false);
    let slice = characters.slice(offset, offset + length).join("");
    const fittingSlice = slice;
    let sliceLength = length;
    if (offset + length < characters.length) {
      const boundary = Math.max(slice.lastIndexOf("\n"), slice.lastIndexOf("。"), slice.lastIndexOf("！"), slice.lastIndexOf("？"));
      if (boundary > slice.length / 2) {
        slice = slice.slice(0, boundary + 1);
        sliceLength = Array.from(slice).length;
      }
    }
    let tokens = await countSlice(slice);
    if (tokens > generation.chunk_tokens && slice !== fittingSlice) {
      // Removing a tokenizer merge at a preferred boundary can increase the count.
      slice = fittingSlice;
      sliceLength = length;
      tokens = await countSlice(slice);
    }
    if (tokens > generation.chunk_tokens) throw new EmbeddingError("invalid_response", true);
    await queue(slice, start);
    offset += sliceLength;
    start += slice.length;
  }
  await flush();
  return chunks;
}

/** Longest code-point prefix whose token count fits, probing a doubling window. */
async function fittingPrefixLength(
  characters: string[],
  offset: number,
  budget: number,
  countAt: (slice: string) => Promise<number>,
): Promise<number> {
  const remaining = characters.length - offset;
  const countLength = (length: number) => countAt(characters.slice(offset, offset + length).join(""));
  let lo = 0;
  let hi = 1;
  while (hi < remaining) {
    if (await countLength(hi) <= budget) {
      lo = hi;
      const doubled = hi * 2;
      hi = doubled > remaining ? remaining : doubled;
    } else {
      break;
    }
  }
  if (hi === remaining && lo !== remaining && await countLength(remaining) <= budget) lo = remaining;
  let low = lo + 1;
  let high = hi - 1;
  let length = lo;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (await countLength(middle) <= budget) { length = middle; low = middle + 1; }
    else high = middle - 1;
  }
  return length;
}

function bindPlainChunk(
  chunk: ContextVectorChunk,
  value: string,
  material: ContextEmbeddingMaterial,
): ContextVectorChunk {
  const part = material.search_parts?.find((entry) =>
    entry.content_hash && entry.projection_start !== undefined && entry.text !== undefined &&
    chunk.start >= entry.projection_start && chunk.end <= entry.projection_start + entry.text.length,
  );
  if (!part?.content_hash) return chunk;
  return {
    ...chunk,
    origin: {
      part_index: part.part_index,
      content_hash: part.content_hash,
      mode: "text",
      start: chunk.start - (part.projection_start ?? 0),
      text: value.slice(chunk.start, chunk.end),
    },
  };
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
