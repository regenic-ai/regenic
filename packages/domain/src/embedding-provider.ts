import { canonicalContextJson, hashCanonicalContext } from "./context-canonical";

export interface EmbeddingModelDescriptor {
  model_id: string;
  model_revision: string;
  tokenizer_revision: string;
  dimensions: number;
  max_input_tokens: number;
  query_template: string;
  document_template: string;
  normalization: "l2";
  similarity: "cosine";
  numeric_format: "float32";
}

export type EmbeddingMode = "document" | "query";

export interface EmbeddingProvider {
  readonly descriptor: EmbeddingModelDescriptor;
  countTokens(texts: string[], mode: EmbeddingMode, signal?: AbortSignal): Promise<number[]>;
  embed(texts: string[], mode: EmbeddingMode, signal?: AbortSignal): Promise<number[][]>;
  health(): Promise<{ status: "ok" | "degraded"; error_code?: string }>;
}

export class EmbeddingError extends Error {
  constructor(
    readonly code: "invalid_input" | "unavailable" | "timeout" | "cancelled" | "invalid_response" | "model_mismatch" | "input_too_large",
    readonly retryable: boolean,
  ) {
    super(`Embedding provider: ${code}`);
    this.name = "EmbeddingError";
  }
}

export interface EmbeddingGeneration {
  id: string;
  model: EmbeddingModelDescriptor;
  extractor_version: "stored-body-text-v1";
  chunker_version: "unicode-token-budget-v1";
  chunk_tokens: number;
  max_chunks_per_event: number;
}

export function embeddingGeneration(
  model: EmbeddingModelDescriptor,
  chunkTokens: number,
  maxChunksPerEvent = 128,
): EmbeddingGeneration {
  validateEmbeddingDescriptor(model);
  if (!Number.isSafeInteger(chunkTokens) || chunkTokens < 32 || chunkTokens > model.max_input_tokens ||
    !Number.isSafeInteger(maxChunksPerEvent) || maxChunksPerEvent < 1 || maxChunksPerEvent > 1024) {
    throw new Error("Invalid embedding chunk budget");
  }
  const recipe = {
    model: structuredClone(model),
    extractor_version: "stored-body-text-v1" as const,
    chunker_version: "unicode-token-budget-v1" as const,
    chunk_tokens: chunkTokens,
    max_chunks_per_event: maxChunksPerEvent,
  };
  return { id: hashCanonicalContext(recipe), ...recipe };
}

export function validateEmbeddingDescriptor(value: EmbeddingModelDescriptor): void {
  if (!value || typeof value.model_id !== "string" || !value.model_id.trim() ||
    !/^[a-f0-9]{40,64}$/.test(value.model_revision) ||
    !/^[a-f0-9]{40,64}$/.test(value.tokenizer_revision) ||
    !Number.isSafeInteger(value.dimensions) || value.dimensions < 1 || value.dimensions > 4096 ||
    !Number.isSafeInteger(value.max_input_tokens) || value.max_input_tokens < 32 || value.max_input_tokens > 131072 ||
    typeof value.query_template !== "string" || !value.query_template.trim() ||
    typeof value.document_template !== "string" || !value.document_template.trim() ||
    value.normalization !== "l2" || value.similarity !== "cosine" || value.numeric_format !== "float32") {
    throw new Error("Invalid embedding model descriptor");
  }
}

export function assertEmbeddingDescriptor(actual: unknown, expected: EmbeddingModelDescriptor): void {
  if (!actual || typeof actual !== "object" || canonicalContextJson(actual) !== canonicalContextJson(expected)) {
    throw new EmbeddingError("model_mismatch", false);
  }
}

export function validateEmbeddingVector(value: number[], dimensions: number): void {
  if (!Array.isArray(value) || value.length !== dimensions) {
    throw new EmbeddingError("invalid_response", true);
  }
  for (let index = 0; index < dimensions; index += 1) {
    if (!Number.isFinite(value[index])) throw new EmbeddingError("invalid_response", true);
  }
  const norm = Math.sqrt(value.reduce((sum, number) => sum + number * number, 0));
  if (!Number.isFinite(norm) || Math.abs(norm - 1) > 0.001) {
    throw new EmbeddingError("invalid_response", true);
  }
}
