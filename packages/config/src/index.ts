import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z
    .string()
    .default("postgres://regenic:regenic@localhost:5432/regenic"),
  REDIS_URL: z.string().default("redis://localhost:6379"),
  LISTEN_HOST: z.string().default("127.0.0.1"),
  REGENIC_AUTHORITY_DRIVER: z.string().optional(),
  REGENIC_DATABASE: z.string().optional(),
  REGENIC_BLOB_ROOT: z.string().optional(),
  REGENIC_ORG: z.string().default("local-owner"),
  REGENIC_MODEL_DRIVER: z.string().default("none"),
  REGENIC_MODEL_BASE_URL: z.string().optional(),
  REGENIC_MODEL_NAME: z.string().optional(),
  REGENIC_MODEL_API_KEY_REF: z.string().optional(),
  REGENIC_MODEL_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1)
    .max(300_000)
    .catch(30_000)
    .default(30_000),
  REGENIC_MODEL_MAX_RESPONSE_BYTES: z.coerce
    .number()
    .int()
    .min(1_024)
    .max(16_777_216)
    .catch(1_048_576)
    .default(1_048_576),
  REGENIC_DSH_API_TOKEN: z.string().optional(),
  REGENIC_DSH_TOKEN: z.string().optional(),
  REGENIC_DSH_BASE_URL: z.string().optional(),
  REGENIC_PERSONAL_API: z.string().optional(),
  REGENIC_PERSONAL_API_KEY: z.string().optional(),
  REGENIC_PERSONAL_PAIRING: z.string().optional(),
  REGENIC_PERSONAL_LIVE_KEY: z.string().optional(),
  REGENIC_REPLICAS: z.string().optional(),
  REGENIC_START_BACKGROUND: z.string().optional(),
});

export type AppEnv = z.infer<typeof envSchema>;

const LOOPBACK_LISTEN_HOSTS = new Set(["127.0.0.1", "::1"]);
const LOOPBACK_ORIGIN_HOSTS = new Set([
  ...LOOPBACK_LISTEN_HOSTS,
  "localhost",
]);
const PERSONAL_EXTENSION_PROTOCOLS = new Set([
  "chrome-extension:",
  "ms-browser-extension:",
]);

export function loadEnv(env: NodeJS.ProcessEnv = process.env): AppEnv {
  return envSchema.parse(env);
}

export type AuthorityBackend =
  | { driver: "sqlite"; path: string; blobRoot: string }
  | { driver: "postgres"; url: string; blobRoot: string }
  | { driver: "none" };

/**
 * Operator contract: an explicit driver plus that driver's keys.
 * DATABASE_URL's zod default is ignored unless the driver is postgres.
 */
export function resolveAuthorityBackend(
  env: AppEnv | NodeJS.ProcessEnv = process.env,
): AuthorityBackend {
  const parsed = isLoadedEnv(env) ? env : loadEnv(env);
  const driver = parsed.REGENIC_AUTHORITY_DRIVER?.trim().toLowerCase() ?? "";
  const sqlitePath = parsed.REGENIC_DATABASE?.trim() ?? "";
  const blobRoot = parsed.REGENIC_BLOB_ROOT?.trim() ?? "";
  const url = parsed.DATABASE_URL?.trim() ?? "";

  if (driver === "postgres") {
    if (!url || !blobRoot) {
      return { driver: "none" };
    }
    return { driver: "postgres", url, blobRoot };
  }
  if (driver === "sqlite") {
    if (!sqlitePath || !blobRoot) {
      return { driver: "none" };
    }
    return { driver: "sqlite", path: sqlitePath, blobRoot };
  }
  if (driver) {
    return { driver: "none" };
  }
  if (sqlitePath && blobRoot) {
    return { driver: "sqlite", path: sqlitePath, blobRoot };
  }
  return { driver: "none" };
}

export function replicaCount(env: AppEnv | NodeJS.ProcessEnv = process.env): number {
  const parsed = isLoadedEnv(env) ? env : loadEnv(env);
  const raw = String(parsed.REGENIC_REPLICAS ?? "").trim();
  if (!raw) {
    return 1;
  }
  const replicas = Number(raw);
  if (!Number.isFinite(replicas) || replicas < 1 || !Number.isInteger(replicas)) {
    throw new Error(`REGENIC_REPLICAS must be a positive integer, got ${raw}`);
  }
  return replicas;
}

/**
 * Personal SQLite is a single writer. A replica count above one is a
 * misconfigured cloud deploy, not a supported scale-out path.
 */
export function assertSqliteSingleReplica(
  env: AppEnv | NodeJS.ProcessEnv = process.env,
): void {
  const parsed = isLoadedEnv(env) ? env : loadEnv(env);
  const backend = resolveAuthorityBackend(parsed);
  const driver = parsed.REGENIC_AUTHORITY_DRIVER?.trim().toLowerCase() ?? "";
  if (backend.driver !== "sqlite" && driver !== "sqlite") {
    return;
  }
  const replicas = replicaCount(parsed);
  if (replicas > 1) {
    throw new Error(
      `Personal SQLite refuses REGENIC_REPLICAS=${replicas}; keep replicas at 1 or switch to PostgreSQL + worker`,
    );
  }
}

/**
 * Cloud workers claim Postgres rows with SKIP LOCKED. SQLite stays on the
 * single-writer API process.
 */
export function assertCloudWorkerBackend(
  env: AppEnv | NodeJS.ProcessEnv = process.env,
): Extract<AuthorityBackend, { driver: "postgres" }> {
  const backend = resolveAuthorityBackend(env);
  if (backend.driver !== "postgres") {
    throw new Error(
      "Cloud worker requires REGENIC_AUTHORITY_DRIVER=postgres and REGENIC_BLOB_ROOT; SQLite stays on the single-writer API process",
    );
  }
  return backend;
}

/**
 * REGENIC_START_BACKGROUND=0|false|none stops connector/work/maintenance
 * timers after listen. Kernel host still comes up for the request path.
 */
export function shouldStartBackgroundWork(
  env: AppEnv | NodeJS.ProcessEnv = process.env,
): boolean {
  const parsed = isLoadedEnv(env) ? env : loadEnv(env);
  const flag = parsed.REGENIC_START_BACKGROUND?.trim().toLowerCase();
  return flag !== "0" && flag !== "false" && flag !== "none";
}

/**
 * Projection and digest belong on the worker when Authority is Postgres.
 * Personal SQLite keeps them in-process. REGENIC_START_BACKGROUND=all forces
 * the API to run them even on Postgres.
 */
export function shouldRunInProcessContextJobs(
  env: AppEnv | NodeJS.ProcessEnv = process.env,
): boolean {
  if (!shouldStartBackgroundWork(env)) {
    return false;
  }
  const parsed = isLoadedEnv(env) ? env : loadEnv(env);
  const flag = parsed.REGENIC_START_BACKGROUND?.trim().toLowerCase();
  if (flag === "all") {
    return true;
  }
  return resolveAuthorityBackend(parsed).driver !== "postgres";
}

/**
 * Postgres API processes elect one timer leader. SQLite always starts timers
 * locally. Followers stay on the HTTP path until they hold the session lock.
 */
export function requiresBackgroundLeader(
  env: AppEnv | NodeJS.ProcessEnv = process.env,
): boolean {
  if (!shouldStartBackgroundWork(env)) {
    return false;
  }
  const parsed = isLoadedEnv(env) ? env : loadEnv(env);
  return resolveAuthorityBackend(parsed).driver === "postgres";
}

export function isLoopbackListenHost(host: string): boolean {
  return LOOPBACK_LISTEN_HOSTS.has(host.trim().toLowerCase());
}

/** Electron file:// sends Origin null; Vite dev uses http://localhost:<port>. */
export function isAllowedPersonalCorsOrigin(origin: string): boolean {
  if (origin === "null") {
    return true;
  }
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol === "file:") {
    return true;
  }
  if (PERSONAL_EXTENSION_PROTOCOLS.has(parsed.protocol)) {
    return !parsed.username && !parsed.password && parsed.hostname.length > 0;
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password
  ) {
    return false;
  }
  return LOOPBACK_ORIGIN_HOSTS.has(parsed.hostname.trim().toLowerCase());
}

/**
 * /v1/me is loopback-only by default.
 * REGENIC_PERSONAL_API=0 disables it even on loopback.
 * REGENIC_PERSONAL_API=1 enables it on a public bind so a desktop can point at that kernel.
 */
export function isPersonalApiEnabled(env: AppEnv | NodeJS.ProcessEnv = process.env): boolean {
  const parsed = isLoadedEnv(env) ? env : loadEnv(env);
  const flag = parsed.REGENIC_PERSONAL_API?.trim().toLowerCase();
  if (flag === "0" || flag === "false") {
    return false;
  }
  if (flag === "1" || flag === "true") {
    return true;
  }
  return isLoopbackListenHost(parsed.LISTEN_HOST);
}

function isLoadedEnv(env: AppEnv | NodeJS.ProcessEnv): env is AppEnv {
  return typeof (env as AppEnv).PORT === "number";
}
