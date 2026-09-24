import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { postgresAuthorityPlugin } from "@regenic/authority-store";
import { fsBlobPlugin } from "@regenic/blob-store";
import { assertCloudWorkerBackend, loadEnv } from "@regenic/config";
import { modelProviderConfigFromEnv } from "@regenic/model-provider";
import type { Host } from "@regenic/plugin-host";
import { createWorkerHost } from "./worker-host";

@Injectable()
export class WorkerRuntimeService implements OnModuleInit, OnModuleDestroy {
  private host: Host | null = null;

  async onModuleInit(): Promise<void> {
    const env = loadEnv();
    const backend = assertCloudWorkerBackend(env);
    const blobRoot = resolve(backend.blobRoot);
    await mkdir(blobRoot, { recursive: true });
    this.host = await createWorkerHost({
      authority: {
        plugin: postgresAuthorityPlugin,
        config: { connectionString: backend.url },
      },
      blobs: { plugin: fsBlobPlugin, config: { root: blobRoot } },
      orgId: env.REGENIC_ORG,
      model: modelProviderConfigFromEnv(process.env),
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.host) {
      await this.host.dispose();
      this.host = null;
    }
  }

  isReady(): boolean {
    return this.host !== null;
  }

  requireHost(): Host {
    if (!this.host) {
      throw new Error("Cloud worker host is not running");
    }
    return this.host;
  }

  orgId(): string {
    return loadEnv().REGENIC_ORG;
  }
}
