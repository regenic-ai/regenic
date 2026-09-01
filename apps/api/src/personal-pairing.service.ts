import { randomBytes, timingSafeEqual } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { PersonalApiKeyService } from "./personal-api-key.service";

const PAIRING_TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 12;

interface PairingWindow {
  code: string;
  expiresAt: number;
}

@Injectable()
export class PersonalPairingService {
  private current: PairingWindow | null = null;
  private attempts = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly keys: PersonalApiKeyService) {}

  snapshot(env: NodeJS.ProcessEnv = process.env): {
    open: boolean;
    code?: string;
    expires_at?: string;
  } {
    if (!this.keys.pairingEnabled(env)) {
      return { open: false };
    }
    const bootstrapUntil = this.keys.pairingExpiresAt();
    const window = this.ensureWindow();
    const expiresAt = bootstrapUntil
      ? Math.min(Date.parse(bootstrapUntil), window.expiresAt)
      : window.expiresAt;
    if (Date.now() >= expiresAt) {
      return { open: false };
    }
    return {
      open: true,
      code: window.code,
      expires_at: new Date(expiresAt).toISOString(),
    };
  }

  async redeem(code: string, remoteIp = "unknown"): Promise<string | null> {
    const key = this.keys.expectedKey();
    if (!key || !this.keys.pairingEnabled()) {
      return null;
    }
    if (!this.allowAttempt(remoteIp)) {
      return null;
    }
    const bootstrapUntil = this.keys.pairingExpiresAt();
    const window = this.ensureWindow();
    const expiresAt = bootstrapUntil
      ? Math.min(Date.parse(bootstrapUntil), window.expiresAt)
      : window.expiresAt;
    if (Date.now() >= expiresAt) {
      return null;
    }
    if (!samePairingCode(code, window.code)) {
      return null;
    }
    this.current = null;
    await this.keys.notePaired();
    return key;
  }

  private ensureWindow(): PairingWindow {
    if (!this.current || Date.now() >= this.current.expiresAt) {
      this.current = {
        code: formatPairingCode(randomBytes(4)),
        expiresAt: Date.now() + PAIRING_TTL_MS,
      };
    }
    return this.current;
  }

  private allowAttempt(remoteIp: string): boolean {
    const now = Date.now();
    const bucket = this.attempts.get(remoteIp);
    if (!bucket || now >= bucket.resetAt) {
      this.attempts.set(remoteIp, { count: 1, resetAt: now + 60_000 });
      return true;
    }
    bucket.count += 1;
    return bucket.count <= MAX_ATTEMPTS;
  }
}

function formatPairingCode(bytes: Buffer): string {
  const raw = bytes.toString("hex").slice(0, 8).toUpperCase();
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

function samePairingCode(left: string, right: string): boolean {
  const normalizedLeft = left.replace(/\s+/g, "").toUpperCase();
  const normalizedRight = right.replace(/\s+/g, "").toUpperCase();
  const leftBytes = Buffer.from(normalizedLeft);
  const rightBytes = Buffer.from(normalizedRight);
  return leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes);
}
