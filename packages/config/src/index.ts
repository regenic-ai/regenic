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
  REGENIC_DSH_API_TOKEN: z.string().optional(),
  REGENIC_DSH_TOKEN: z.string().optional(),
  REGENIC_PERSONAL_API: z.string().optional(),
});

export type AppEnv = z.infer<typeof envSchema>;

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function loadEnv(env: NodeJS.ProcessEnv = process.env): AppEnv {
  return envSchema.parse(env);
}

export function isLoopbackListenHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
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
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password
  ) {
    return false;
  }
  return isLoopbackListenHost(parsed.hostname);
}

/** /v1/me is loopback-only. REGENIC_PERSONAL_API=0 disables it even on loopback. */
export function isPersonalApiEnabled(env: AppEnv | NodeJS.ProcessEnv = process.env): boolean {
  const parsed = isLoadedEnv(env) ? env : loadEnv(env);
  const flag = parsed.REGENIC_PERSONAL_API?.trim().toLowerCase();
  if (flag === "0" || flag === "false") {
    return false;
  }
  return isLoopbackListenHost(parsed.LISTEN_HOST);
}

function isLoadedEnv(env: AppEnv | NodeJS.ProcessEnv): env is AppEnv {
  return typeof (env as AppEnv).PORT === "number";
}
