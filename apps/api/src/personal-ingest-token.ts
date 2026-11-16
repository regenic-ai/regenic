import { createHmac, timingSafeEqual } from "node:crypto";

export const INGEST_TOKEN_HEADER = "x-regenic-ingest-token";

const INGEST_TOKEN_PATH =
  /^\/v1\/me\/connectors\/([^/]+)\/(ingest|limits|ingest-stats|watermarks(?:\/summary)?)$/;

/**
 * Installation-scoped push credential derived from the personal API key.
 * Rotating the personal key revokes every ingest token; deleting an
 * installation revokes its own. Nothing is stored.
 */
export function ingestTokenFor(personalKey: string, installationId: string): string {
  return createHmac("sha256", personalKey)
    .update(`regenic-ingest-v1:${installationId}`)
    .digest("base64url");
}

export function ingestTokenMatches(
  personalKey: string | null | undefined,
  installationId: string,
  provided: string | null | undefined,
): boolean {
  const key = personalKey?.trim();
  const token = provided?.trim();
  if (!key || !token) {
    return false;
  }
  const expected = Buffer.from(ingestTokenFor(key, installationId));
  const actual = Buffer.from(token);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Installation id addressed by a path an ingest token may call. */
export function ingestTokenInstallationId(path: string): string | undefined {
  const match = INGEST_TOKEN_PATH.exec(path);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}
