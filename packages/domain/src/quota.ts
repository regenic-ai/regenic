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

/**
 * One token bucket per installation. Connectors may declare a tighter
 * quota; the kernel never maps source names to rate constants.
 */
export class InstallationQuotaBook {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly fallback: ConnectorQuota = connectorQuotaFromEnv(),
    private readonly now: () => number = () => Date.now(),
  ) {}

  tryConsume(
    installationId: string,
    quota?: Partial<ConnectorQuota> | null,
  ): boolean {
    const resolved = normalizeConnectorQuota(quota, this.fallback);
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
    if (bucket.tokens < 1) {
      this.buckets.set(installationId, bucket);
      return false;
    }
    bucket.tokens -= 1;
    this.buckets.set(installationId, bucket);
    return true;
  }
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
