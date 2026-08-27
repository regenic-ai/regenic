import type { JsonValue } from "./ingestion";

export const EXECUTOR_KINDS = ["local_connector", "http"] as const;

export type ExecutorKind = (typeof EXECUTOR_KINDS)[number];

export const EXECUTOR_INSTALL_STATUSES = ["enabled", "disabled"] as const;

export type ExecutorInstallStatus = (typeof EXECUTOR_INSTALL_STATUSES)[number];

/** Seeded local DSH binding. Existing recipes keep `executor_type: "dsh"`. */
export const DEFAULT_LOCAL_EXECUTOR_ID = "dsh";

export const EXECUTOR_DEFAULTS_SEEDED_PREF = "executor_defaults_seeded";

export interface ExecutorInstallation {
  id: string;
  org_id: string;
  kind: ExecutorKind;
  name: string;
  status: ExecutorInstallStatus;
  config: Record<string, JsonValue>;
  created_at: string;
  updated_at: string;
}

export interface ExecutorStore {
  listExecutorInstallations(orgId: string): Promise<ExecutorInstallation[]>;
  getExecutorInstallation(
    orgId: string,
    id: string,
  ): Promise<ExecutorInstallation | null>;
  putExecutorInstallation(
    installation: ExecutorInstallation,
  ): Promise<ExecutorInstallation>;
  deleteExecutorInstallation(orgId: string, id: string): Promise<boolean>;
}

export function isExecutorKind(value: unknown): value is ExecutorKind {
  return value === "local_connector" || value === "http";
}

export function isExecutorInstallStatus(
  value: unknown,
): value is ExecutorInstallStatus {
  return value === "enabled" || value === "disabled";
}

export function executorConfigText(
  config: Record<string, JsonValue> | undefined,
  key: string,
): string {
  const value = config?.[key];
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeExecutorHttpUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Executor URL is required");
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Executor URL is invalid");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Executor URL must be http or https");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Executor URL must not include credentials");
  }
  const host = parsed.hostname.toLowerCase();
  if (!host || host === "0.0.0.0" || BLOCKED_EXECUTOR_HOSTS.has(host)) {
    throw new Error("Executor URL host is not allowed");
  }
  return parsed.toString().replace(/\/$/, "");
}

const BLOCKED_EXECUTOR_HOSTS = new Set([
  "169.254.169.254",
  "metadata.google.internal",
  "metadata.goog",
]);

export function normalizeExecutorAuthEnv(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) {
    throw new Error("Token environment variable name is invalid");
  }
  return trimmed;
}

export function defaultLocalExecutorInstallation(
  orgId: string,
  now: string,
): ExecutorInstallation {
  return {
    id: DEFAULT_LOCAL_EXECUTOR_ID,
    org_id: orgId,
    kind: "local_connector",
    name: "DSH",
    status: "enabled",
    config: {},
    created_at: now,
    updated_at: now,
  };
}

export function normalizeExecutorInstallConfig(
  kind: ExecutorKind,
  config: Record<string, unknown> | undefined,
): Record<string, JsonValue> {
  const input = config ?? {};
  if (kind === "http") {
    const baseUrl = normalizeExecutorHttpUrl(
      typeof input.base_url === "string" ? input.base_url : "",
    );
    const authEnv =
      typeof input.auth_env === "string"
        ? normalizeExecutorAuthEnv(input.auth_env)
        : "";
    const timeout = parseTimeoutMs(input.timeout_ms);
    return {
      base_url: baseUrl,
      ...(authEnv ? { auth_env: authEnv } : {}),
      ...(timeout ? { timeout_ms: timeout } : {}),
    };
  }
  const installationId =
    typeof input.installation_id === "string"
      ? input.installation_id.trim()
      : "";
  return installationId ? { installation_id: installationId } : {};
}

function parseTimeoutMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return parsed > 0 ? parsed : undefined;
  }
  return undefined;
}
