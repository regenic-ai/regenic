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
});

export type AppEnv = z.infer<typeof envSchema>;

export function loadEnv(env: NodeJS.ProcessEnv = process.env): AppEnv {
  return envSchema.parse(env);
}
