import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import {
  assertSqliteSingleReplica,
  loadEnv,
  resolveAuthorityBackend,
  shouldStartBackgroundWork,
  shouldRunInProcessContextJobs,
} from "@regenic/config";
import { embeddingConfigFromEnv } from "@regenic/embedding-provider";
import { SqliteContextVectorIndex } from "@regenic/vector-index";
import { postgresAuthorityPlugin, sqliteAuthorityPlugin } from "@regenic/authority-store";
import { fsBlobPlugin } from "@regenic/blob-store";
import { compactEmbeddedContent } from "@regenic/domain";
import { modelProviderConfigFromEnv, type ModelProviderPluginConfig } from "@regenic/model-provider";
import type { Host } from "@regenic/plugin-host";
import {
  HUMAN_IDLE_MS,
  isHumanIdle,
  markKernelReady,
} from "./personal-human-pace";
import { createKernelHost } from "./kernel-host";
import { semanticIssue } from "./semantic-diagnostics";

export interface KernelRuntimeOptions {
  blobRoot: string;
  orgId: string;
  database?: string;
  model?: ModelProviderPluginConfig;
}

@Injectable()
export class PersonalRuntimeService implements OnModuleInit, OnModuleDestroy {
  private host: Host | null = null;
  private options: KernelRuntimeOptions | null = null;
  private compactAbort: AbortController | null = null;
  private compacting: Promise<ContentCompactOutcome> | null = null;
  private compactTimer: ReturnType<typeof setTimeout> | undefined;
  private compactFinished = false;
  private embeddingTimer: ReturnType<typeof setInterval> | undefined;
  private embeddingEnabled = false;

  async onModuleInit(): Promise<void> {
    const env = loadEnv();
    assertSqliteSingleReplica(env);
    const backend = resolveAuthorityBackend(env);
    const embedding = embeddingConfigFromEnv(process.env);
    if (embedding && backend.driver !== "sqlite") {
      throw new Error("Embedding indexing currently requires the personal SQLite backend");
    }
    if (backend.driver === "none") {
      return;
    }
    const blobRoot = resolve(backend.blobRoot);
    await mkdir(blobRoot, { recursive: true });
    const model = modelProviderConfigFromEnv(process.env);
    if (backend.driver === "sqlite") {
      const database = resolve(backend.path);
      await mkdir(dirname(database), { recursive: true });
      this.options = {
        database,
        blobRoot,
        orgId: env.REGENIC_ORG,
        model,
      };
      this.host = await createKernelHost({
        authority: {
          plugin: sqliteAuthorityPlugin,
          config: { path: database },
        },
        blobs: { plugin: fsBlobPlugin, config: { root: blobRoot } },
        orgId: env.REGENIC_ORG,
        lexicalDatabase: `${database}.lexical.db`,
        embedding: embedding ? { ...embedding, database: `${database}.vector.db` } : undefined,
        model,
      });
      this.embeddingEnabled = embedding !== undefined;
      return;
    }
    this.options = {
      blobRoot,
      orgId: env.REGENIC_ORG,
      model,
    };
    this.host = await createKernelHost({
      authority: {
        plugin: postgresAuthorityPlugin,
        config: { connectionString: backend.url },
      },
      blobs: { plugin: fsBlobPlugin, config: { root: blobRoot } },
      orgId: env.REGENIC_ORG,
      model,
    });
  }

  startAfterListen(): void {
    markKernelReady();
    this.scheduleCompact();
    if (!this.embeddingTimer && this.embeddingEnabled && this.host && shouldStartBackgroundWork() && shouldRunInProcessContextJobs()) {
      this.embeddingTimer = setInterval(() => {
        if (!isHumanIdle() || !this.host) return;
        if (this.host.get("context-vector-status").status !== "ready") return;
        void this.host.get("context-embedding-worker").runOnce().then((result) => {
          if (result.failed) console.warn("embedding jobs failed", result.failed);
        }).catch(() => {
          console.error("embedding reconciliation failed", "indexing_failed");
        });
      }, 2000);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.embeddingTimer) {
      clearInterval(this.embeddingTimer);
      this.embeddingTimer = undefined;
    }
    this.compactFinished = true;
    if (this.compactTimer) {
      clearTimeout(this.compactTimer);
      this.compactTimer = undefined;
    }
    this.compactAbort?.abort();
    if (this.compacting) {
      await this.compacting;
      this.compacting = null;
    }
    if (this.host) {
      await this.host.dispose();
      this.host = null;
    }
  }

  isReady(): boolean {
    return this.host !== null;
  }

  async semanticStatus() {
    const host = this.requireHost();
    if (!this.embeddingEnabled) return { configured: false, healthy: false, vector_status: "disabled", generations: [] };
    const health = await host.get("embedding").health();
    const vector = host.get("context-vector-status");
    if (vector.status !== "ready") return {
      configured: true, healthy: health.status === "ok", vector_status: vector.status, generations: [],
      ...("error_code" in health ? { provider_issue: semanticIssue(health.error_code) } : {}),
    };
    const generations = await host.get("context-vector-generations").listGenerations(this.orgId());
    return {
      configured: true, healthy: health.status === "ok", vector_status: vector.status,
      ...("error_code" in health ? { provider_issue: semanticIssue(health.error_code) } : {}),
      generations: await Promise.all(generations.map(async ({ manifest, active }) => {
        const jobs = await host.get("context-embedding-jobs").listJobs(this.orgId(), manifest.id);
        const counts = { pending: 0, running: 0, succeeded: 0, failed: 0, quarantined: 0, superseded: 0 };
        const failures = new Map<ReturnType<typeof semanticIssue>, { code: ReturnType<typeof semanticIssue>; failed: number; quarantined: number }>();
        for (const job of jobs) counts[job.status]++;
        for (const job of jobs) {
          if (job.status !== "failed" && job.status !== "quarantined") continue;
          const code = semanticIssue(job.error_code);
          const bucket = failures.get(code) ?? { code, failed: 0, quarantined: 0 };
          bucket[job.status]++;
          failures.set(code, bucket);
        }
        return { id: manifest.id, active, jobs: counts,
          failures: [...failures.values()].sort((a, b) => a.code.localeCompare(b.code)) };
      })),
    };
  }

  async indexSemanticOnce() {
    const host = this.requireHost();
    if (!this.embeddingEnabled || host.get("context-vector-status").status !== "ready") {
      throw new Error("Semantic indexing is not configured or the vector store is unavailable");
    }

    return host.get("context-embedding-worker").runOnce();
  }

  async retrySemantic(generation: string, limit: number) {
    const retried = await this.requireHost().get("context-embedding-jobs")
      .retryFailed(this.orgId(), generation, limit);
    return { retried };
  }

  /**
   * Probe the mounted authority through its own pool/connection.
   * Sqlite has no live remote dependency — host presence is enough.
   * Postgres must answer SELECT 1 or health reports down.
   */
  async probeAuthority(timeoutMs = 2_000): Promise<boolean> {
    if (!this.host) {
      return false;
    }
    const authority = this.host.get("authority") as {
      ping?: () => Promise<void>;
    };
    if (typeof authority.ping !== "function") {
      return true;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        authority.ping(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("authority probe timed out")),
            timeoutMs,
          );
        }),
      ]);
      return true;
    } catch {
      return false;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  getHost(): Host | null {
    return this.host;
  }

  requireHost(): Host {
    if (!this.host) {
      throw new PersonalKernelStoppedError();
    }
    return this.host;
  }

  getOptions(): KernelRuntimeOptions | null {
    return this.options;
  }

  async clearEmbeddingProjection(): Promise<void> {
    const database = this.options?.database;
    if (!database || !existsSync(`${database}.vector.db`)) return;
    if (this.embeddingEnabled && this.host?.get("context-vector-status").status === "ready") {
      await this.host.get("context-embedding-worker").clearProjection();
      return;
    }
    const index = new SqliteContextVectorIndex(`${database}.vector.db`);
    try {
      await index.clearOrganization(this.orgId());
    } finally {
      index.close();
    }
  }

  orgId(): string {
    return loadEnv().REGENIC_ORG;
  }

  private scheduleCompact(): void {
    if (
      this.compactFinished ||
      this.compactTimer ||
      this.compacting ||
      !this.host
    ) {
      return;
    }
    this.compactTimer = setTimeout(() => {
      this.compactTimer = undefined;
      void this.maybeStartCompact();
    }, HUMAN_IDLE_MS);
  }

  private async maybeStartCompact(): Promise<void> {
    if (this.compactFinished || this.compacting || !this.host) {
      return;
    }
    if (!isHumanIdle()) {
      this.scheduleCompact();
      return;
    }
    this.compactAbort = new AbortController();
    this.compacting = compactLocalContent(
      this.host,
      this.orgId(),
      this.compactAbort.signal,
      this.options?.database,
    );
    const outcome = await this.compacting;
    this.compacting = null;
    if (shouldRetryContentCompact(outcome)) {
      this.scheduleCompact();
    }
    if (shouldFinishContentCompact(outcome)) {
      this.compactFinished = true;
    }
  }
}

export class PersonalKernelStoppedError extends Error {
  constructor() {
    super("Personal kernel is not running");
    this.name = "PersonalKernelStoppedError";
  }
}

export type ContentCompactOutcome = "done" | "paused" | "aborted" | "failed";

export function shouldRetryContentCompact(outcome: ContentCompactOutcome): boolean {
  return outcome === "paused" || outcome === "failed";
}

export function shouldFinishContentCompact(outcome: ContentCompactOutcome): boolean {
  return outcome === "done";
}

export function contentCompactScanOutcome(result: {
  rewritten: number;
  failed: number;
}): ContentCompactOutcome {
  return result.failed > 0 ? "failed" : "done";
}

export function contentCompactFailureOutcome(
  error: unknown,
  aborted: boolean,
): ContentCompactOutcome {
  if (aborted || isWriteWorkerClosed(error)) {
    return "aborted";
  }
  return "failed";
}

async function compactLocalContent(
  host: Host,
  orgId: string,
  signal: AbortSignal,
  databasePath?: string,
): Promise<ContentCompactOutcome> {
  try {
    const result = await compactEmbeddedContent(
      host.get("authority"),
      host.get("blobs"),
      orgId,
      {
        signal,
        pauseIf: () => !isHumanIdle(),
      },
    );
    if (signal.aborted) {
      return "aborted";
    }
    if (result.paused || !isHumanIdle()) {
      return "paused";
    }
    const outcome = contentCompactScanOutcome(result);
    if (result.rewritten > 0) {
      try {
        await host.get("authority").vacuumStore();
      } catch (error) {
        if (signal.aborted || isWriteWorkerClosed(error)) {
          return "aborted";
        }
        console.warn("vacuum after content compact failed", error);
      }
      if (signal.aborted) {
        return "aborted";
      }
      console.info(
        `compacted ${result.rewritten} message envelopes, released ${result.released_bytes} bytes`,
      );
    }
    return outcome;
  } catch (error) {
    const outcome = contentCompactFailureOutcome(error, signal.aborted);
    if (outcome === "failed") {
      const target = databasePath ? ` (${databasePath})` : "";
      console.warn(`content compact failed${target}`, error);
    }
    return outcome;
  }
}

function isWriteWorkerClosed(error: unknown): boolean {
  return (
    error instanceof Error &&
    /Authority write worker (closed|exited)/.test(error.message)
  );
}
