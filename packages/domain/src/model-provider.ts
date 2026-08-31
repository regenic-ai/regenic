export type ModelCompletionFormat = "text" | "json";

export interface ModelMessage {
  role: "system" | "user";
  content: string;
}

export interface ModelCompletionRequest {
  messages: ModelMessage[];
  format: ModelCompletionFormat;
  temperature?: number;
  max_output_tokens?: number;
}

export interface ModelCompletionResult {
  text: string;
  model: string;
  finish_reason?: string;
}

export interface ModelHealth {
  status: "ok" | "degraded";
  driver: string;
  model?: string;
}

export interface ModelProvider {
  complete(request: ModelCompletionRequest): Promise<ModelCompletionResult>;
  health(): Promise<ModelHealth>;
}

export class ModelUnavailableError extends Error {
  constructor(message = "Model provider is not configured") {
    super(message);
    this.name = "ModelUnavailableError";
  }
}

export class ModelTimeoutError extends Error {
  constructor(message = "Model request timed out") {
    super(message);
    this.name = "ModelTimeoutError";
  }
}

export class ModelUpstreamError extends Error {
  constructor(message = "Model provider request failed") {
    super(message);
    this.name = "ModelUpstreamError";
  }
}
