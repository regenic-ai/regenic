import {
  CURSOR_API_KEY_ENV,
  CursorApiError,
  CursorCloudClient,
  DEFAULT_CURSOR_API_BASE,
  type CursorFetch,
} from "./cursor-api-client";
import type { ConnectorCatalogProbe } from "@regenic/domain";

export const CURSOR_KEY_MISSING_HINT =
  "Paste a Cursor API key in the install form, or set CURSOR_API_KEY.";
export const CURSOR_KEY_INVALID_HINT =
  "CURSOR_API_KEY was rejected. Create a new key in Cursor Dashboard → API Keys.";
export const CURSOR_KEY_READY_HINT = "Cursor API key is valid.";

const PROBE_TTL_MS = 20_000;
const PROBE_FAIL_TTL_MS = 2_000;

let cache: { at: number; ready: boolean; hint: string } | null = null;

export function cursorApiCatalogHint(input: {
  present: boolean;
  ready: boolean;
}): string {
  if (!input.present) {
    return CURSOR_KEY_MISSING_HINT;
  }
  return input.ready ? CURSOR_KEY_READY_HINT : CURSOR_KEY_INVALID_HINT;
}

export function resetCursorProbeCache(): void {
  cache = null;
}

export async function probeCursorCatalog(options: {
  env?: NodeJS.ProcessEnv;
  fetch?: CursorFetch;
  now?: () => number;
} = {}): Promise<ConnectorCatalogProbe> {
  const env = options.env ?? process.env;
  const key = env[CURSOR_API_KEY_ENV]?.trim() ?? "";
  if (!key) {
    return {
      services: {
        "cursor-api": {
          ready: false,
          hint: CURSOR_KEY_MISSING_HINT,
        },
      },
    };
  }
  const now = options.now ?? Date.now;
  const at = now();
  if (cache && at - cache.at < (cache.ready ? PROBE_TTL_MS : PROBE_FAIL_TTL_MS)) {
    return {
      services: {
        "cursor-api": { ready: cache.ready, hint: cache.hint },
      },
    };
  }
  let ready = false;
  try {
    await new CursorCloudClient({
      api_key: key,
      base_url: env.REGENIC_CURSOR_API_BASE ?? DEFAULT_CURSOR_API_BASE,
      fetch: options.fetch,
    }).me();
    ready = true;
  } catch (error) {
    ready = false;
    if (!(error instanceof CursorApiError)) {
      ready = false;
    }
  }
  const hint = cursorApiCatalogHint({ present: true, ready });
  cache = { at, ready, hint };
  return {
    services: {
      "cursor-api": { ready, hint },
    },
  };
}
