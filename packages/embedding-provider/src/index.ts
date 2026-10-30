import { createHash } from "node:crypto";
import {
  assertEmbeddingDescriptor,
  EmbeddingError,
  validateEmbeddingVector,
  type EmbeddingMode,
  type EmbeddingModelDescriptor,
  type EmbeddingProvider,
  type EmbeddingAttachmentInput,
  type ProcessedEmbeddingAttachment,
} from "@regenic/domain";
import { definePlugin } from "@regenic/plugin-host";

export const EMBEDDINGGEMMA_2: Readonly<EmbeddingModelDescriptor> = Object.freeze({
  model_id: "google/embeddinggemma-2",
  model_revision: "914f7f89142e33e77833254d9c9b90c3cef7303b",
  tokenizer_revision: "914f7f89142e33e77833254d9c9b90c3cef7303b",
  dimensions: 768,
  max_input_tokens: 8192,
  query_template: "task: search result | query: ",
  document_template: "title: none | text: ",
  normalization: "l2",
  similarity: "cosine",
  numeric_format: "float32",
});

export interface LocalEmbeddingOptions {
  base_url: string;
  timeout_ms?: number;
  fetch?: typeof fetch;
}

export interface LocalEmbeddingConfig extends LocalEmbeddingOptions {
  chunk_tokens: number;
  max_chunks_per_event: number;
}

export function embeddingConfigFromEnv(env: NodeJS.ProcessEnv): LocalEmbeddingConfig | undefined {
  const driver = env.REGENIC_EMBEDDING_DRIVER?.trim() || "none";
  if (driver === "none") return undefined;
  if (driver !== "local_http") throw new Error("Unsupported embedding driver");
  const config = {
    base_url: env.REGENIC_EMBEDDING_BASE_URL ?? "",
    timeout_ms: integer(env.REGENIC_EMBEDDING_TIMEOUT_MS, 30000, 1, 300000),
    chunk_tokens: integer(env.REGENIC_EMBEDDING_CHUNK_TOKENS, 256, 32, EMBEDDINGGEMMA_2.max_input_tokens),
    max_chunks_per_event: integer(env.REGENIC_EMBEDDING_MAX_CHUNKS, 128, 1, 1024),
  };
  endpoint(config.base_url);
  return config;
}

export class LocalHttpEmbeddingProvider implements EmbeddingProvider {
  readonly descriptor = EMBEDDINGGEMMA_2;
  private readonly base: string;
  private readonly timeout: number;
  private readonly request: typeof fetch;
  private readonly attachments = new Map<string, { material: ProcessedEmbeddingAttachment; size: number }>();
  private attachmentBytes = 0;

  constructor(options: LocalEmbeddingOptions) {
    this.base = endpoint(options.base_url);
    this.timeout = integer(options.timeout_ms?.toString(), 30000, 1, 300000);
    this.request = options.fetch ?? fetch;
  }

  async countTokens(texts: string[], mode: EmbeddingMode, signal?: AbortSignal): Promise<number[]> {
    const value = await this.call("tokens", texts, mode, signal);
    if (!Array.isArray(value.counts) || value.counts.length !== texts.length ||
      value.counts.some((count: unknown) => typeof count !== "number" || !Number.isSafeInteger(count) || count < 1)) {
      throw new EmbeddingError("invalid_response", true);
    }
    return value.counts;
  }

  async embed(texts: string[], mode: EmbeddingMode, signal?: AbortSignal): Promise<number[][]> {
    const value = await this.call("embed", texts, mode, signal);
    if (!Array.isArray(value.vectors) || value.vectors.length !== texts.length) {
      throw new EmbeddingError("invalid_response", true);
    }
    for (const vector of value.vectors) validateEmbeddingVector(vector, this.descriptor.dimensions);
    return value.vectors;
  }

  async health() {
    try {
      await this.countTokens(["health"], "query");
      return { status: "ok" as const };
    } catch (error) {
      if (!(error instanceof EmbeddingError)) throw error;
      return { status: "degraded" as const, error_code: error.code };
    }
  }

  async processAttachment(
    attachment: EmbeddingAttachmentInput,
    signal?: AbortSignal,
  ): Promise<ProcessedEmbeddingAttachment> {
    if (!(attachment.bytes instanceof Uint8Array) || attachment.bytes.byteLength === 0 ||
      typeof attachment.media_type !== "string" || attachment.media_type.length > 256 ||
      (attachment.source_filename !== undefined &&
        (typeof attachment.source_filename !== "string" || attachment.source_filename.length > 1024))) {
      throw new EmbeddingError("invalid_input", false);
    }
    if (attachment.bytes.byteLength > 16 * 1024 * 1024) throw new EmbeddingError("input_too_large", false);
    if (signal?.aborted) throw new EmbeddingError("cancelled", true);
    const key = createHash("sha256")
      .update(JSON.stringify([attachment.media_type, attachment.source_filename]))
      .update(attachment.bytes).digest("hex");
    const cached = this.attachments.get(key);
    if (cached) {
      this.attachments.delete(key);
      this.attachments.set(key, cached);
      return structuredClone(cached.material);
    }
    const body = JSON.stringify({
      descriptor: this.descriptor,
      media_type: attachment.media_type,
      source_filename: attachment.source_filename,
      bytes_base64: Buffer.from(attachment.bytes).toString("base64"),
    });
    const value = await this.requestBody("attachment", body, signal, Math.max(this.timeout, 300000));
    if ((value.text !== undefined &&
        (typeof value.text !== "string" || Buffer.byteLength(value.text, "utf8") > 262144)) ||
      !Array.isArray(value.vectors) || value.vectors.length > 128) {
      throw new EmbeddingError("invalid_response", true);
    }
    for (const vector of value.vectors) validateEmbeddingVector(vector, this.descriptor.dimensions);
    if (!(typeof value.text === "string" && value.text.trim()) && value.vectors.length === 0) {
      throw new EmbeddingError("invalid_input", false);
    }
    const material: ProcessedEmbeddingAttachment = {
      ...(typeof value.text === "string" ? { text: value.text } : {}),
      vectors: value.vectors,
    };
    const size = Buffer.byteLength(material.text ?? "", "utf8") +
      material.vectors.length * this.descriptor.dimensions * 8;
    this.attachments.set(key, { material: structuredClone(material), size });
    this.attachmentBytes += size;
    while (this.attachments.size > 128 || this.attachmentBytes > 16 * 1024 * 1024) {
      const oldest = this.attachments.keys().next().value!;
      this.attachmentBytes -= this.attachments.get(oldest)!.size;
      this.attachments.delete(oldest);
    }
    return material;
  }

  private async call(path: string, texts: string[], mode: EmbeddingMode, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (!Array.isArray(texts) || texts.length < 1 || texts.length > 32 ||
      (mode !== "document" && mode !== "query") ||
      texts.some((text) => typeof text !== "string" || !text.length || Buffer.byteLength(text, "utf8") > 262144)) {
      throw new EmbeddingError("invalid_input", false);
    }
    const body = JSON.stringify({ descriptor: this.descriptor, mode, texts });
    if (Buffer.byteLength(body, "utf8") > 1048576) throw new EmbeddingError("invalid_input", false);
    return this.requestBody(path, body, signal, this.timeout);
  }

  private async requestBody(
    path: string, body: string, signal: AbortSignal | undefined, timeout: number,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    if (signal?.aborted) throw new EmbeddingError("cancelled", true);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeout);
    let response: Response | undefined;
    try {
      response = await this.request(`${this.base}/${path}`, {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json", accept: "application/json" },
        signal: controller.signal,
        body,
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 413) throw new EmbeddingError("input_too_large", false);
        if (response.status === 409) throw new EmbeddingError("model_mismatch", false);
        if (response.status === 415) throw new EmbeddingError("unsupported_attachment", false);
        throw new EmbeddingError(response.status === 400 ? "invalid_input" : "unavailable", response.status !== 400);
      }
      if (!response.body || Number(response.headers.get("content-length")) > 4194304) {
        await response.body?.cancel();
        throw new EmbeddingError("invalid_response", true);
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > 4194304) {
            await reader.cancel();
            throw new EmbeddingError("invalid_response", true);
          }
          chunks.push(next.value);
        }
      } finally {
        reader.releaseLock();
      }
      let value: unknown;
      try {
        value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw new EmbeddingError("invalid_response", true);
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new EmbeddingError("invalid_response", true);
      const result = value as Record<string, unknown>;
      assertEmbeddingDescriptor(result.descriptor, this.descriptor);
      return result;
    } catch (error) {
      if (signal?.aborted) throw new EmbeddingError("cancelled", true);
      if (controller.signal.aborted) throw new EmbeddingError("timeout", true);
      if (error instanceof EmbeddingError) throw error;
      throw new EmbeddingError("unavailable", true);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
}

export const localEmbeddingProviderPlugin = definePlugin<LocalEmbeddingOptions>({
  name: "embedding-provider-local-http",
  apply(ctx, options) {
    ctx.provide("embedding", new LocalHttpEmbeddingProvider(options));
  },
});

function endpoint(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Embedding URL must be numeric loopback HTTP"); }
  if (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Embedding URL must be numeric loopback HTTP without a path");
  }
  return url.origin;
}

function integer(value: string | undefined, fallback: number, min: number, max: number): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new Error("Invalid embedding numeric configuration");
  return result;
}
