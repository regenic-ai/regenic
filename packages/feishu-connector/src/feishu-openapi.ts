export class FeishuApiError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "FeishuApiError";
  }
}

export type FeishuSortType = "ByCreateTimeAsc" | "ByCreateTimeDesc";

export const FEISHU_OPEN_API_CN = "https://open.feishu.cn";
export const FEISHU_OPEN_API_LARK = "https://open.larksuite.com";

const TOKEN_CODES = new Set([
  "99991663",
  "99991664",
  "99991668",
  "99991677",
  "99991679",
]);

export function feishuOpenApiBaseUrl(brand?: string): string {
  const value = brand?.trim().toLowerCase();
  if (value === "lark" || value === "larksuite") {
    return FEISHU_OPEN_API_LARK;
  }
  return FEISHU_OPEN_API_CN;
}

export function isFeishuTokenError(error: unknown): boolean {
  const code = error instanceof FeishuApiError ? error.code : undefined;
  if (code && TOKEN_CODES.has(code)) {
    return true;
  }
  const text = error instanceof Error ? error.message : String(error);
  return /token invalid|invalid.*token|user unauthorized|access token/i.test(text);
}

export async function callFeishuOpenApi(input: {
  method: "GET" | "POST";
  path: string;
  token: string;
  params?: Record<string, string | number>;
  data?: unknown;
  form?: FormData;
  base_url?: string;
  fetch?: typeof fetch;
  timeout_ms?: number;
}): Promise<unknown> {
  const fetchFn = input.fetch ?? fetch;
  const url = new URL(input.path, input.base_url ?? FEISHU_OPEN_API_CN);
  for (const [key, value] of Object.entries(input.params ?? {})) {
    url.searchParams.set(key, String(value));
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${input.token}`,
  };
  const body = requestBody(input.method, input.form, input.data);
  if (body && typeof body === "string") {
    headers["Content-Type"] = "application/json";
  }
  const timeoutMs = input.timeout_ms ?? 20_000;
  const signal =
    timeoutMs > 0 && typeof AbortSignal !== "undefined" && "timeout" in AbortSignal
      ? AbortSignal.timeout(timeoutMs)
      : undefined;
  let response: Response;
  try {
    response = await fetchFn(url.toString(), {
      method: input.method,
      headers,
      body,
      signal,
    });
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (/aborted|timeout|TimeoutError/i.test(text)) {
      throw new FeishuApiError(`Feishu HTTP timed out after ${timeoutMs}ms`);
    }
    throw new FeishuApiError(`Feishu HTTP request failed: ${text}`);
  }
  const payload = await readJson(response);
  if (isObject(payload) && typeof payload.code === "number" && payload.code !== 0) {
    throw new FeishuApiError(
      stringValue(payload.msg) ?? `Feishu API error ${payload.code}`,
      String(payload.code),
    );
  }
  if (!response.ok) {
    throw new FeishuApiError(
      `Feishu HTTP ${response.status}`,
      String(response.status),
    );
  }
  if (isObject(payload) && "data" in payload) {
    return payload.data;
  }
  return payload;
}

export async function callFeishuOpenApiBytes(input: {
  method: "GET" | "POST";
  path: string;
  token: string;
  params?: Record<string, string | number>;
  base_url?: string;
  fetch?: typeof fetch;
  timeout_ms?: number;
}): Promise<{ bytes: Uint8Array; media_type: string; filename?: string }> {
  const fetchFn = input.fetch ?? fetch;
  const url = new URL(input.path, input.base_url ?? FEISHU_OPEN_API_CN);
  for (const [key, value] of Object.entries(input.params ?? {})) {
    url.searchParams.set(key, String(value));
  }
  const timeoutMs = input.timeout_ms ?? 20_000;
  const signal =
    timeoutMs > 0 && typeof AbortSignal !== "undefined" && "timeout" in AbortSignal
      ? AbortSignal.timeout(timeoutMs)
      : undefined;
  let response: Response;
  try {
    response = await fetchFn(url.toString(), {
      method: input.method,
      headers: { Authorization: `Bearer ${input.token}` },
      signal,
    });
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (/aborted|timeout|TimeoutError/i.test(text)) {
      throw new FeishuApiError(`Feishu HTTP timed out after ${timeoutMs}ms`);
    }
    throw new FeishuApiError(`Feishu HTTP request failed: ${text}`);
  }
  const contentType = headerValue(response, "content-type");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (looksLikeJson(contentType, bytes)) {
    const payload = parseJsonBytes(bytes);
    if (isObject(payload)) {
      throw new FeishuApiError(
        stringValue(payload.msg) ?? "Feishu download returned JSON instead of file bytes",
        typeof payload.code === "number" ? String(payload.code) : undefined,
      );
    }
    if (!response.ok) {
      throw new FeishuApiError(
        `Feishu HTTP ${response.status}`,
        String(response.status),
      );
    }
  }
  if (!response.ok) {
    throw new FeishuApiError(
      `Feishu HTTP ${response.status}`,
      String(response.status),
    );
  }
  const mediaType = contentType.split(";")[0]?.trim() || "application/octet-stream";
  return {
    bytes,
    media_type: mediaType === "application/json" ? "application/octet-stream" : mediaType,
    filename: contentDispositionFilename(headerValue(response, "content-disposition")),
  };
}

function requestBody(
  method: "GET" | "POST",
  form: FormData | undefined,
  data: unknown,
): string | FormData | undefined {
  if (method !== "POST") {
    return undefined;
  }
  if (form) {
    return form;
  }
  if (data !== undefined) {
    return JSON.stringify(data);
  }
  return undefined;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim().length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new FeishuApiError(
      response.ok
        ? "Feishu HTTP returned invalid JSON"
        : `Feishu HTTP ${response.status}`,
    );
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function headerValue(response: Response, name: string): string {
  const headers = response.headers;
  if (!headers) {
    return "";
  }
  if (typeof headers.get === "function") {
    return headers.get(name) ?? "";
  }
  const raw = (headers as unknown as Record<string, string>)[name];
  return raw ?? "";
}

function looksLikeJson(contentType: string, bytes: Uint8Array): boolean {
  if (contentType.includes("application/json")) {
    return true;
  }
  return bytes.length > 0 && bytes[0] === 0x7b;
}

function parseJsonBytes(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function contentDispositionFilename(header: string): string | undefined {
  const utf = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf?.[1]) {
    try {
      return decodeURIComponent(utf[1]);
    } catch {
      return utf[1];
    }
  }
  const plain = header.match(/filename="?([^"]+)"?/i);
  return plain?.[1]?.trim() || undefined;
}
