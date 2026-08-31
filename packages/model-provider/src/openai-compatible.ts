import {
  ModelTimeoutError,
  ModelUpstreamError,
  readEnvCredential,
  type ModelCompletionRequest,
  type ModelCompletionResult,
  type ModelProvider,
} from "@regenic/domain";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576;
const MAX_MESSAGE_CHARS = 2_000_000;
const MAX_MESSAGES = 100;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]"]);

export interface OpenAICompatibleModelProviderOptions {
  base_url: string;
  model: string;
  api_key_ref?: string;
  timeout_ms?: number;
  max_response_bytes?: number;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
}

export class OpenAICompatibleModelProvider implements ModelProvider {
  private readonly endpoint: string;
  private readonly model: string;
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly request: typeof fetch;

  constructor(options: OpenAICompatibleModelProviderOptions) {
    this.endpoint = completionEndpoint(options.base_url);
    this.model = requiredString(options.model, "Model name");
    this.apiKey = readEnvCredential(options.api_key_ref, options.env ?? process.env);
    if (options.api_key_ref && !this.apiKey) {
      throw new Error("Model API key reference could not be resolved");
    }
    this.timeoutMs = boundedInteger(
      options.timeout_ms ?? DEFAULT_TIMEOUT_MS,
      1,
      300_000,
      "Model timeout",
    );
    this.maxResponseBytes = boundedInteger(
      options.max_response_bytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      1_024,
      16_777_216,
      "Model response limit",
    );
    this.request = options.fetch ?? fetch;
  }

  async complete(request: ModelCompletionRequest): Promise<ModelCompletionResult> {
    validateCompletionRequest(request);
    const headers: Record<string, string> = {
      accept: "application/json",
      "content-type": "application/json",
    };
    if (this.apiKey) {
      headers.authorization = `Bearer ${this.apiKey}`;
    }
    let response: Response;
    try {
      response = await this.request(this.endpoint, {
        method: "POST",
        redirect: "error",
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
        body: JSON.stringify({
          model: this.model,
          messages: request.messages,
          ...(request.format === "json"
            ? { response_format: { type: "json_object" } }
            : {}),
          ...(request.temperature === undefined
            ? {}
            : { temperature: request.temperature }),
          ...(request.max_output_tokens === undefined
            ? {}
            : { max_tokens: request.max_output_tokens }),
        }),
      });
    } catch (error) {
      if (isTimeoutError(error)) {
        throw new ModelTimeoutError();
      }
      throw new ModelUpstreamError();
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new ModelUpstreamError(`Model provider returned HTTP ${response.status}`);
    }
    let bytes: Uint8Array;
    try {
      bytes = await readBoundedResponse(response, this.maxResponseBytes);
    } catch (error) {
      if (error instanceof ModelUpstreamError) {
        throw error;
      }
      if (isTimeoutError(error)) {
        throw new ModelTimeoutError();
      }
      throw new ModelUpstreamError();
    }
    let body: unknown;
    try {
      body = JSON.parse(Buffer.from(bytes).toString("utf8"));
    } catch {
      throw new ModelUpstreamError("Model provider returned invalid JSON");
    }
    return parseCompletion(body, this.model);
  }

  async health() {
    return {
      status: "ok" as const,
      driver: "openai_compatible",
      model: this.model,
    };
  }
}

function completionEndpoint(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(requiredString(baseUrl, "Model base URL"));
  } catch {
    throw new Error("Model base URL must be a valid HTTP URL");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())
  ) {
    throw new Error("Model base URL must use a numeric loopback host");
  }
  parsed.pathname = `${parsed.pathname.replace(/\/+$/, "")}/chat/completions`;
  return parsed.toString();
}

function validateCompletionRequest(request: ModelCompletionRequest): void {
  if (
    !request ||
    !Array.isArray(request.messages) ||
    request.messages.length === 0 ||
    request.messages.length > MAX_MESSAGES ||
    (request.format !== "text" && request.format !== "json") ||
    request.messages.some((message) =>
      !message ||
      (message.role !== "system" && message.role !== "user") ||
      typeof message.content !== "string" ||
      !message.content.trim() ||
      message.content.length > MAX_MESSAGE_CHARS,
    ) ||
    (request.temperature !== undefined &&
      (!Number.isFinite(request.temperature) ||
        request.temperature < 0 ||
        request.temperature > 2)) ||
    (request.max_output_tokens !== undefined &&
      (!Number.isSafeInteger(request.max_output_tokens) ||
        request.max_output_tokens < 1 ||
        request.max_output_tokens > 32_768))
  ) {
    throw new Error("Invalid model completion request");
  }
}

async function readBoundedResponse(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new ModelUpstreamError("Model response exceeds the configured limit");
  }
  if (!response.body) {
    throw new ModelUpstreamError("Model provider returned an empty response");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ModelUpstreamError("Model response exceeds the configured limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function parseCompletion(value: unknown, fallbackModel: string): ModelCompletionResult {
  const body = asRecord(value);
  const choices = Array.isArray(body.choices) ? body.choices : [];
  const choice = asRecord(choices[0]);
  const message = asRecord(choice.message);
  if (typeof message.content !== "string" || !message.content.trim()) {
    throw new ModelUpstreamError("Model provider returned no completion text");
  }
  return {
    text: message.content,
    model: typeof body.model === "string" && body.model.trim()
      ? body.model.trim()
      : fallbackModel,
    ...(typeof choice.finish_reason === "string"
      ? { finish_reason: choice.finish_reason }
      : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function requiredString(value: string, label: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${label} is required`);
  }
  return trimmed;
}

function boundedInteger(
  value: number,
  min: number,
  max: number,
  label: string,
): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label} is out of range`);
  }
  return value;
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof DOMException &&
    (error.name === "TimeoutError" || error.name === "AbortError");
}
