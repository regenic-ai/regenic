import {
  sanitizeConnectorLimits,
  type ConnectorLimits,
} from "@regenic/connector-contract";
import { currentSyncLane } from "./sync-budget";
import type { SyncLane } from "./sync-contracts";

export interface ConnectorQuota {
  tokens: number;
  window_ms: number;
}

export const DEFAULT_QUOTA_TOKENS = 60;
export const DEFAULT_QUOTA_WINDOW_MS = 60_000;

export function connectorQuotaFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ConnectorQuota {
  return {
    tokens: clampQuotaNumber(
      env.REGENIC_CONNECTOR_QUOTA_TOKENS,
      DEFAULT_QUOTA_TOKENS,
      0,
      10_000,
    ),
    window_ms: clampQuotaNumber(
      env.REGENIC_CONNECTOR_QUOTA_WINDOW_MS,
      DEFAULT_QUOTA_WINDOW_MS,
      1_000,
      3_600_000,
    ),
  };
}

export function normalizeConnectorQuota(
  quota?: Partial<ConnectorQuota> | null,
  fallback: ConnectorQuota = connectorQuotaFromEnv(),
): ConnectorQuota {
  return {
    tokens: clampQuotaNumber(quota?.tokens, fallback.tokens, 0, 10_000),
    window_ms: clampQuotaNumber(
      quota?.window_ms,
      fallback.window_ms,
      1_000,
      3_600_000,
    ),
  };
}

interface Bucket {
  tokens: number;
  updated_at: number;
}

export interface InstallationLimitsView {
  /** Last limits the connector declared for this installation. */
  declared?: ConnectorLimits;
  /** Runtime adjustment; replaces declared fields until cleared. */
  runtime?: ConnectorLimits;
  effective: {
    max_concurrency?: number;
    page_size?: number;
    rate: ConnectorQuota;
  };
  inflight: number;
}

/**
 * One token bucket per installation. Connectors may declare a tighter
 * quota; the kernel never maps source names to rate constants.
 */
export class InstallationQuotaBook {
  private readonly buckets = new Map<string, Bucket>();
  private override: ConnectorQuota | undefined;
  private readonly declared = new Map<string, ConnectorLimits>();
  private readonly runtime = new Map<string, ConnectorLimits>();
  private readonly inflight = new Map<string, number>();

  constructor(
    private readonly fallback: ConnectorQuota = connectorQuotaFromEnv(),
    private readonly now: () => number = () => Date.now(),
  ) {}

  configure(quota?: ConnectorQuota): void {
    if (this.override?.tokens === quota?.tokens &&
        this.override?.window_ms === quota?.window_ms) {
      return;
    }
    this.override = quota ? { ...quota } : undefined;
    this.buckets.clear();
  }

  /** Records what the connector declares; called on every core pull. */
  declare(installationId: string, limits?: ConnectorLimits | null): void {
    const sanitized = sanitizeConnectorLimits(limits);
    if (sanitized) {
      this.declared.set(installationId, sanitized);
    } else {
      this.declared.delete(installationId);
    }
  }

  /** Runtime adjustment from the connector. `undefined` restores the declaration. */
  adjust(installationId: string, limits?: ConnectorLimits | null): void {
    const sanitized = sanitizeConnectorLimits(limits);
    if (sanitized) {
      this.runtime.set(installationId, sanitized);
    } else {
      this.runtime.delete(installationId);
    }
  }

  forget(installationId: string): void {
    this.buckets.delete(installationId);
    this.declared.delete(installationId);
    this.runtime.delete(installationId);
    this.inflight.delete(installationId);
  }

  limits(installationId: string, hint?: Partial<ConnectorQuota> | null): InstallationLimitsView {
    const merged = this.mergedLimits(installationId);
    return {
      ...(this.declared.has(installationId)
        ? { declared: { ...this.declared.get(installationId) } }
        : {}),
      ...(this.runtime.has(installationId)
        ? { runtime: { ...this.runtime.get(installationId) } }
        : {}),
      effective: {
        ...(merged.max_concurrency ? { max_concurrency: merged.max_concurrency } : {}),
        ...(merged.page_size ? { page_size: merged.page_size } : {}),
        rate: this.resolveRate(installationId, hint),
      },
      inflight: this.inflight.get(installationId) ?? 0,
    };
  }

  pageSize(installationId: string): number | undefined {
    return this.mergedLimits(installationId).page_size;
  }

  /**
   * Non-blocking concurrency gate. Returns a release function, or `undefined`
   * when the installation already runs `max_concurrency` pulls.
   */
  tryAcquireSlot(installationId: string): (() => void) | undefined {
    const max = this.mergedLimits(installationId).max_concurrency;
    const current = this.inflight.get(installationId) ?? 0;
    if (max !== undefined && current >= max) {
      return undefined;
    }
    this.inflight.set(installationId, current + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (this.inflight.get(installationId) ?? 1) - 1;
      if (next > 0) {
        this.inflight.set(installationId, next);
      } else {
        this.inflight.delete(installationId);
      }
    };
  }

  tryConsume(
    installationId: string,
    quota?: Partial<ConnectorQuota> | null,
    lane: SyncLane = currentSyncLane(),
  ): boolean {
    const resolved = this.resolveRate(installationId, quota);
    if (resolved.tokens <= 0) {
      return true;
    }
    const now = this.now();
    const bucket = this.buckets.get(installationId) ?? {
      tokens: resolved.tokens,
      updated_at: now,
    };
    const elapsed = Math.max(0, now - bucket.updated_at);
    const refill = (elapsed / resolved.window_ms) * resolved.tokens;
    bucket.tokens = Math.min(resolved.tokens, bucket.tokens + refill);
    bucket.updated_at = now;
    const reserved =
      lane === "interactive" ? 0 : reservedInteractiveTokens(resolved.tokens);
    if (bucket.tokens < 1 + reserved) {
      this.buckets.set(installationId, bucket);
      return false;
    }
    bucket.tokens -= 1;
    this.buckets.set(installationId, bucket);
    return true;
  }

  /**
   * User settings win over declared rates. A runtime adjustment can only
   * tighten the result: it reports upstream pushback the user cannot see.
   */
  private resolveRate(
    installationId: string,
    hint?: Partial<ConnectorQuota> | null,
  ): ConnectorQuota {
    const declared = this.declared.get(installationId)?.rate ?? hint;
    const base = this.override ?? normalizeConnectorQuota(declared, this.fallback);
    const adjusted = this.runtime.get(installationId)?.rate;
    return adjusted ? tighterQuota(base, adjusted) : base;
  }

  private mergedLimits(installationId: string): ConnectorLimits {
    const declared = this.declared.get(installationId);
    const runtime = this.runtime.get(installationId);
    const maxConcurrency = tighterOptionalLimit(
      declared?.max_concurrency,
      runtime?.max_concurrency,
    );
    const pageSize = tighterOptionalLimit(
      declared?.page_size,
      runtime?.page_size,
    );
    const rate = runtime?.rate ?? declared?.rate;
    return {
      ...(maxConcurrency !== undefined ? { max_concurrency: maxConcurrency } : {}),
      ...(pageSize !== undefined ? { page_size: pageSize } : {}),
      ...(rate ? { rate } : {}),
    };
  }
}

function tighterOptionalLimit(
  declared: number | undefined,
  runtime: number | undefined,
): number | undefined {
  if (declared === undefined) return runtime;
  if (runtime === undefined) return declared;
  return Math.min(declared, runtime);
}

/** `tokens: 0` means unlimited, so any finite budget is tighter. */
function tighterQuota(a: ConnectorQuota, b: ConnectorQuota): ConnectorQuota {
  if (a.tokens <= 0) return { ...b };
  if (b.tokens <= 0) return { ...a };
  return b.tokens / b.window_ms < a.tokens / a.window_ms ? { ...b } : { ...a };
}

/** Leave a slice of the install bucket for Interactive so backfill cannot starve reading. */
export function reservedInteractiveTokens(total: number): number {
  if (total < 5) {
    return 0;
  }
  return Math.min(Math.floor(total * 0.2), total - 1);
}

function clampQuotaNumber(
  raw: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = Number(raw ?? fallback);
  if (!Number.isFinite(value)) {
    return fallback;
  }
  if (value <= 0) {
    return min === 0 ? 0 : fallback;
  }
  return Math.max(min === 0 ? 1 : min, Math.min(Math.floor(value), max));
}
