import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { loadEnv, resolveAuthorityBackend } from "@regenic/config";
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

  async onModuleInit(): Promise<void> {
    const env = loadEnv();
    const backend = resolveAuthorityBackend(env);
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
        model,
      });
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
  }

  async onModuleDestroy(): Promise<void> {
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
