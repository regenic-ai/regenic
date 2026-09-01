import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Injectable, OnModuleInit } from "@nestjs/common";
import {
  isLoopbackListenHost,
  isPersonalApiEnabled,
  loadEnv,
} from "@regenic/config";

export type PersonalApiKeySource = "env" | "file" | "generated" | "none";

const KEY_FILE = ".regenic-personal-api-key";
/** First boot only: enough time to Apply from desktop, not a standing public invite. */
export const BOOTSTRAP_PAIRING_MS = 30 * 60 * 1000;

interface StoredPersonalApiKey {
  key: string;
  created_at: string;
  pairing_until: string;
  first_paired_at?: string;
}

@Injectable()
export class PersonalApiKeyService implements OnModuleInit {
  private key: string | null = null;
  private source: PersonalApiKeySource = "none";
  private record: StoredPersonalApiKey | null = null;
  private keyPath: string | null = null;

  async onModuleInit(): Promise<void> {
    const env = loadEnv();
    const fromEnv = env.REGENIC_PERSONAL_API_KEY?.trim();
    if (fromEnv) {
      this.key = fromEnv;
      this.source = "env";
      return;
    }
    if (!env.REGENIC_DATABASE || !isPersonalApiEnabled(env)) {
      return;
    }
    this.keyPath = join(dirname(env.REGENIC_DATABASE), KEY_FILE);
    const stored = await this.readStoredKey(this.keyPath);
    if (stored) {
      this.record = stored;
      this.key = stored.key;
      this.source = "file";
      return;
    }
    const createdAt = new Date();
    const record: StoredPersonalApiKey = {
      key: randomBytes(32).toString("base64url"),
      created_at: createdAt.toISOString(),
      pairing_until: new Date(createdAt.getTime() + BOOTSTRAP_PAIRING_MS).toISOString(),
    };
    await this.writeStoredKey(this.keyPath, record);
    this.record = record;
    this.key = record.key;
    this.source = "generated";
    process.stderr.write(
      `[regenic] Personal API key generated at ${this.keyPath}. Bootstrap pairing is open until ${record.pairing_until}. Set REGENIC_PERSONAL_API_KEY to manage access manually.\n`,
    );
  }

  expectedKey(): string | null {
    return this.key;
  }

  keySource(): PersonalApiKeySource {
    return this.source;
  }

  authRequired(env: NodeJS.ProcessEnv = process.env): boolean {
    if (this.key) {
      return true;
    }
    return !isLoopbackListenHost(loadEnv(env).LISTEN_HOST);
  }

  pairingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return this.pairingState(env).open;
  }

  pairingState(env: NodeJS.ProcessEnv = process.env): {
    open: boolean;
    reason?: "bootstrap" | "admin" | "paired" | "expired" | "disabled" | "env_key";
  } {
    const flag = loadEnv(env).REGENIC_PERSONAL_PAIRING?.trim().toLowerCase();
    if (flag === "0" || flag === "false") {
      return { open: false, reason: "disabled" };
    }
    if (!this.key) {
      return { open: false, reason: "disabled" };
    }
    if (this.source === "env") {
      if (flag === "1" || flag === "true") {
        return { open: true, reason: "admin" };
      }
      return { open: false, reason: "env_key" };
    }
    if (flag === "1" || flag === "true") {
      return { open: true, reason: "admin" };
    }
    if (this.record?.first_paired_at) {
      return { open: false, reason: "paired" };
    }
    const pairingUntil = this.record?.pairing_until;
    if (!pairingUntil) {
      return { open: false, reason: "disabled" };
    }
    if (Date.now() >= Date.parse(pairingUntil)) {
      return { open: false, reason: "expired" };
    }
    return { open: true, reason: "bootstrap" };
  }

  pairingExpiresAt(env: NodeJS.ProcessEnv = process.env): string | null {
    const state = this.pairingState(env);
    if (!state.open || state.reason !== "bootstrap") {
      return null;
    }
    return this.record?.pairing_until ?? null;
  }

  async notePaired(): Promise<void> {
    if (!this.keyPath || !this.record || this.record.first_paired_at) {
      return;
    }
    this.record = {
      ...this.record,
      first_paired_at: new Date().toISOString(),
    };
    await this.writeStoredKey(this.keyPath, this.record);
  }

  private async readStoredKey(
    keyPath: string,
  ): Promise<StoredPersonalApiKey | null> {
    try {
      const raw = (await readFile(keyPath, "utf8")).trim();
      if (!raw) {
        return null;
      }
      if (raw.startsWith("{")) {
        const parsed = JSON.parse(raw) as Partial<StoredPersonalApiKey>;
        const key = parsed.key?.trim();
        const created_at = parsed.created_at?.trim();
        const pairing_until = parsed.pairing_until?.trim();
        if (!key || !created_at || !pairing_until) {
          return null;
        }
        return {
          key,
          created_at,
          pairing_until,
          ...(parsed.first_paired_at?.trim()
            ? { first_paired_at: parsed.first_paired_at.trim() }
            : {}),
        };
      }
      const createdAt = new Date(0);
      return {
        key: raw,
        created_at: createdAt.toISOString(),
        pairing_until: createdAt.toISOString(),
        first_paired_at: createdAt.toISOString(),
      };
    } catch {
      return null;
    }
  }

  private async writeStoredKey(
    keyPath: string,
    record: StoredPersonalApiKey,
  ): Promise<void> {
    await mkdir(dirname(keyPath), { recursive: true });
    await writeFile(keyPath, `${JSON.stringify(record, null, 2)}\n`, {
      mode: 0o600,
    });
  }
}
