import { mkdir } from "node:fs/promises";
import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { loadEnv } from "@regenic/config";
import type { Host } from "@regenic/plugin-host";
import {
  createPersonalHost,
  type PersonalHostOptions,
} from "./personal-host";

@Injectable()
export class PersonalRuntimeService implements OnModuleInit, OnModuleDestroy {
  private host: Host | null = null;
  private options: PersonalHostOptions | null = null;

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

  async onModuleDestroy(): Promise<void> {
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
}

export class PersonalKernelStoppedError extends Error {
  constructor() {
    super("Personal kernel is not running");
    this.name = "PersonalKernelStoppedError";
  }
}
