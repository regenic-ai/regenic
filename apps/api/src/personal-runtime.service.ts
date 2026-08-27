import { mkdir } from "node:fs/promises";
import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { loadEnv } from "@regenic/config";
import { compactEmbeddedContent } from "@regenic/domain";
import type { Host } from "@regenic/plugin-host";
import {
  HUMAN_IDLE_MS,
  isHumanIdle,
  markKernelReady,
} from "./personal-human-pace";
import {
  createPersonalHost,
  type PersonalHostOptions,
} from "./personal-host";

@Injectable()
export class PersonalRuntimeService implements OnModuleInit, OnModuleDestroy {
  private host: Host | null = null;
  private options: PersonalHostOptions | null = null;
  private compactAbort: AbortController | null = null;
  private compacting: Promise<ContentCompactOutcome> | null = null;
  private compactTimer: ReturnType<typeof setTimeout> | undefined;
  private compactFinished = false;

  async onModuleInit(): Promise<void> {
    const env = loadEnv();
    if (!env.REGENIC_DATABASE || !env.REGENIC_BLOB_ROOT) {
      return;
    }
    await mkdir(env.REGENIC_BLOB_ROOT, { recursive: true });
    this.options = {
      database: env.REGENIC_DATABASE,
      blobRoot: env.REGENIC_BLOB_ROOT,
    };
    this.host = await createPersonalHost(this.options);
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

  getHost(): Host | null {
    return this.host;
  }

  requireHost(): Host {
    if (!this.host) {
      throw new PersonalKernelStoppedError();
    }
    return this.host;
  }

  getOptions(): PersonalHostOptions | null {
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
      console.warn("content compact failed", error);
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
