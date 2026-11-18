import { z } from "zod";

export const SERVER_APP_PROTOCOL = "1.0" as const;
export const SERVER_APP_MANIFEST_PATH = "/.well-known/regenic";
export const SERVER_APP_CONNECT_PATH = "/v1/regenic/connections";
export const SERVER_APP_INVOKE_PATH = "/v1/regenic/invoke";

const nonBlank = z.string().trim().min(1);
const absolutePath = nonBlank.refine(
  (value) => value.startsWith("/") && !value.startsWith("//"),
  "Endpoint must be an absolute path",
);

export const ServerAppCapabilitiesSchema = z
  .object({
    source: z
      .object({
        push: z.boolean().default(false),
        pull: z.boolean().default(false),
        reply: z.boolean().default(false),
        create: z.boolean().default(false),
      })
      .strict()
      .optional(),
    agent: z.boolean().default(false),
  })
  .strict()
  .refine(
    (value) =>
      value.agent === true ||
      value.source?.push === true ||
      value.source?.pull === true ||
      value.source?.reply === true ||
      value.source?.create === true,
    "Server app must declare at least one capability",
  );

export const ServerAppManifestSchema = z
  .object({
    protocol: z.literal(SERVER_APP_PROTOCOL),
    app_id: nonBlank.max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
    name: nonBlank.max(200),
    description: z.string().trim().max(1_000).optional(),
    capabilities: ServerAppCapabilitiesSchema,
    endpoints: z
      .object({
        connect: absolutePath.default(SERVER_APP_CONNECT_PATH),
        invoke: absolutePath.default(SERVER_APP_INVOKE_PATH),
        runs: z.literal("/v1/runs").default("/v1/runs"),
      })
      .strict()
      .default({
        connect: SERVER_APP_CONNECT_PATH,
        invoke: SERVER_APP_INVOKE_PATH,
        runs: "/v1/runs",
      }),
  })
  .strict();

export type ServerAppManifest = z.infer<typeof ServerAppManifestSchema>;

export const ServerAppConnectionRequestSchema = z
  .object({
    protocol: z.literal(SERVER_APP_PROTOCOL),
    installation_id: nonBlank,
    namespace: z
      .object({
        source: nonBlank,
        id_prefix: nonBlank,
      })
      .strict(),
    ingest: z
      .object({
        url: z.string().url(),
        header: z.literal("x-regenic-ingest-token"),
        token: nonBlank,
      })
      .strict()
      .optional(),
  })
  .strict();

export type ServerAppConnectionRequest = z.infer<
  typeof ServerAppConnectionRequestSchema
>;

export const ServerAppConnectionResponseSchema = z
  .object({
    protocol: z.literal(SERVER_APP_PROTOCOL),
    connection_id: nonBlank.max(256),
  })
  .strict();

export type ServerAppConnectionResponse = z.infer<
  typeof ServerAppConnectionResponseSchema
>;

export function parseServerAppManifest(value: unknown): ServerAppManifest {
  return ServerAppManifestSchema.parse(value);
}

export function parseServerAppConnectionResponse(
  value: unknown,
): ServerAppConnectionResponse {
  return ServerAppConnectionResponseSchema.parse(value);
}
