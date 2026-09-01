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
  REGENIC_PERSONAL_LIVE_KEY: z.string().optional(),
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
