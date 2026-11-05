import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { CONNECTOR_PROTOCOL } from "@regenic/domain";

const INDEX_TIMEOUT_MS = 8_000;
const MAX_INDEX_BYTES = 2 * 1024 * 1024;
const MAX_CONNECTORS = 200;
const MAX_RELEASES_PER_CONNECTOR = 100;
const NPM_PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u;
const SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const SHA512_INTEGRITY = /^sha512-[A-Za-z0-9+/]+={0,2}$/u;
const CACHE_TTL_MS = 60_000;
export const OFFICIAL_CONNECTOR_MARKET_INDEX_URL =
  "https://raw.githubusercontent.com/regenic-ai/regenic/main/market/connectors.json";

export interface ConnectorMarketRelease {
  version: string;
  published_at: string;
  engines_regenic: string;
  compatible: boolean;
  integrity: string;
  driver_exports: string[];
  executor_exports: string[];
}

export interface ConnectorMarketItem {
  name: string;
  title: string;
  description: string;
  author?: string;
  homepage?: string;
  repository?: string;
  keywords: string[];
  versions: ConnectorMarketRelease[];
}

export interface ConnectorMarketView {
  configured: boolean;
  title: string | null;
  connectors: ConnectorMarketItem[];
}

interface CacheEntry {
  url: string;
  expiresAt: number;
  view: ConnectorMarketView;
}

@Injectable()
export class ConnectorMarketService {
  private cache: CacheEntry | undefined;

  async getMarket(
    refresh = false,
    env: NodeJS.ProcessEnv = process.env,
    fetchImpl: typeof fetch = fetch,
  ): Promise<ConnectorMarketView> {
    const configuredUrl = env.REGENIC_CONNECTOR_MARKET_INDEX_URL?.trim();
    if (configuredUrl?.toLowerCase() === "off") {
      return { configured: false, title: null, connectors: [] };
    }

    const url = parseIndexUrl(configuredUrl || OFFICIAL_CONNECTOR_MARKET_INDEX_URL);
    if (
      !refresh &&
      this.cache?.url === url.href &&
      this.cache.expiresAt > Date.now()
    ) {
      return this.cache.view;
    }

    try {
      const response = await fetchImpl(url, {
        headers: { accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(INDEX_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`Market index returned HTTP ${response.status}`);
      }
      const index = parseMarketIndex(await readIndex(response));
      const view: ConnectorMarketView = {
        configured: true,
        title: index.title,
        connectors: index.connectors,
      };
      this.cache = { url: url.href, expiresAt: Date.now() + CACHE_TTL_MS, view };
      return view;
    } catch (error) {
      console.warn("regenic connector market: index request failed", error);
      throw new ServiceUnavailableException({
        error: {
          code: "connector_market_unavailable",
          message: "The connector market is temporarily unavailable.",
        },
      });
    }
  }
}

function parseIndexUrl(value: string): URL {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error("Invalid market index URL");
    }
    return url;
  } catch {
    throw new ServiceUnavailableException({
      error: {
        code: "connector_market_misconfigured",
        message: "The connector market index URL must be an HTTPS URL.",
      },
    });
  }
}

async function readIndex(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_INDEX_BYTES) {
    throw new Error("Market index exceeds the response size limit");
  }
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Market index response is empty");
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_INDEX_BYTES) {
      await reader.cancel();
      throw new Error("Market index exceeds the response size limit");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("Market index is not valid UTF-8 JSON");
  }
}

function parseMarketIndex(value: unknown): {
  title: string;
  connectors: ConnectorMarketItem[];
} {
  if (!isRecord(value) || value.format !== 1) {
    throw new Error("Unsupported market index format");
  }
  const title = boundedText(value.title, 200);
  if (!title || !Array.isArray(value.connectors) || value.connectors.length > MAX_CONNECTORS) {
    throw new Error("Invalid market index");
  }
  const seen = new Set<string>();
  const connectors = value.connectors.map((item) => {
    if (
      !isRecord(item) ||
      typeof item.name !== "string" ||
      !NPM_PACKAGE_NAME.test(item.name) ||
      seen.has(item.name) ||
      !Array.isArray(item.versions) ||
      item.versions.length === 0 ||
      item.versions.length > MAX_RELEASES_PER_CONNECTOR
    ) {
      throw new Error("Invalid connector entry in market index");
    }
    seen.add(item.name);
    const title = boundedText(item.title, 200) || item.name;
    const description = boundedText(item.description, 2_000) || "";
    const versions = item.versions.map(parseRelease);
    const author = boundedText(item.author, 200);
    const homepage = safeWebUrl(item.homepage);
    const repository = safeWebUrl(item.repository);
    return {
      name: item.name,
      title,
      description,
      ...(author ? { author } : {}),
      ...(homepage ? { homepage } : {}),
      ...(repository ? { repository } : {}),
      keywords: boundedStringList(item.keywords, 50, 100),
      versions,
    };
  });
  return { title, connectors };
}

function parseRelease(value: unknown): ConnectorMarketRelease {
  const driverExports = isRecord(value) && Array.isArray(value.driver_exports)
    ? value.driver_exports.filter(
        (name): name is string =>
          typeof name === "string" && Boolean(boundedText(name, 100)),
      )
    : [];
  const executorExports = isRecord(value) && Array.isArray(value.executor_exports)
    ? value.executor_exports.filter(
        (name): name is string =>
          typeof name === "string" && Boolean(boundedText(name, 100)),
      )
    : [];
  if (
    !isRecord(value) ||
    typeof value.version !== "string" ||
    !SEMVER.test(value.version) ||
    typeof value.published_at !== "string" ||
    !Number.isFinite(Date.parse(value.published_at)) ||
    typeof value.engines_regenic !== "string" ||
    !boundedText(value.engines_regenic, 200) ||
    typeof value.integrity !== "string" ||
    !validIntegrity(value.integrity) ||
    !Array.isArray(value.driver_exports) ||
    driverExports.length === 0 ||
    driverExports.length > 50 ||
    driverExports.length !== value.driver_exports.length ||
    (value.executor_exports !== undefined && !Array.isArray(value.executor_exports)) ||
    executorExports.length > 50 ||
    (Array.isArray(value.executor_exports) &&
      executorExports.length !== value.executor_exports.length)
  ) {
    throw new Error("Invalid connector release in market index");
  }
  return {
    version: value.version,
    published_at: new Date(value.published_at).toISOString(),
    engines_regenic: value.engines_regenic.trim(),
    compatible: value.engines_regenic.trim() === CONNECTOR_PROTOCOL,
    integrity: value.integrity,
    driver_exports: [...new Set(driverExports)].sort(),
    executor_exports: [...new Set(executorExports)].sort(),
  };
}

function validIntegrity(value: string): boolean {
  if (!SHA512_INTEGRITY.test(value)) return false;
  const encoded = value.slice("sha512-".length);
  const bytes = Buffer.from(encoded, "base64");
  return bytes.byteLength === 64 && bytes.toString("base64") === encoded;
}

function safeWebUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password
    ) {
      return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
}

function boundedText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text && text.length <= maxLength ? text : undefined;
}

function boundedStringList(
  value: unknown,
  maxItems: number,
  maxLength: number,
): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.flatMap((item) => {
    const text = boundedText(item, maxLength);
    return text ? [text] : [];
  }))].slice(0, maxItems);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
