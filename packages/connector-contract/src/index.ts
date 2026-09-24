/**
 * Serializable boundary between Sync Core and a connector host.
 *
 * Keep this package free of storage, Nest, plugin-host, and connector
 * implementation dependencies so the same envelopes can be used in-process,
 * over stdio, or over RPC.
 */

export const CONNECTOR_INVOCATION_PROTOCOL = "1.0" as const;

export type ConnectorJson =
  | null
  | boolean
  | number
  | string
  | ConnectorJson[]
  | { [key: string]: ConnectorJson };

export type ConnectorInvocationKind =
  | "describe"
  | "validate_install"
  | "list_directory"
  | "resolve_streams"
  | "poll"
  | "translate_webhook"
  | "send"
  | "lifecycle";

export interface ConnectorInvocationContext {
  request_id: string;
  installation_id: string;
  connector_type: string;
  deadline_at?: string;
  cancellation_id?: string;
  idempotency_key?: string;
}

export interface ConnectorRequestEnvelope<TPayload extends ConnectorJson = ConnectorJson> {
  protocol: typeof CONNECTOR_INVOCATION_PROTOCOL;
  kind: ConnectorInvocationKind;
  context: ConnectorInvocationContext;
  payload: TPayload;
}

export interface ConnectorInvocationError {
  code: string;
  message: string;
  retryable: boolean;
  retry_after_ms?: number;
}

export type ConnectorResponseEnvelope<TResult extends ConnectorJson = ConnectorJson> =
  | {
      protocol: typeof CONNECTOR_INVOCATION_PROTOCOL;
      request_id: string;
      ok: true;
      result: TResult;
    }
  | {
      protocol: typeof CONNECTOR_INVOCATION_PROTOCOL;
      request_id: string;
      ok: false;
      error: ConnectorInvocationError;
    };

/**
 * A stream descriptor is data, not a callback-bearing connector object.
 * `binding` is connector-owned opaque state and must remain JSON serializable.
 */
export interface ConnectorStreamDescriptor {
  stream_key: string;
  thread_id?: string;
  label?: string;
  binding?: ConnectorJson;
  pace?: {
    idle_ms?: number;
    catch_up_pages?: number;
  };
}

export interface ConnectorPollPayload {
  stream: ConnectorStreamDescriptor;
  cursor?: string;
  older?: boolean;
  /** Ask the connector for the newest page. Hosts must forward this; it is not lane state. */
  latest?: boolean;
  media?: boolean;
}

export interface ConnectorPollResultPayload<TBatch extends ConnectorJson = ConnectorJson> {
  batch: TBatch;
  next_cursor?: string;
  has_more?: boolean;
  media_pending?: boolean;
  poll_hint?: {
    live_seeded?: boolean;
    history_pending?: boolean;
  };
  retry_after_ms?: number;
}

export interface ConnectorInvoker {
  invoke<TPayload extends ConnectorJson, TResult extends ConnectorJson>(
    request: ConnectorRequestEnvelope<TPayload>,
  ): Promise<ConnectorResponseEnvelope<TResult>>;
}

export function assertConnectorRequestEnvelope(
  value: unknown,
): asserts value is ConnectorRequestEnvelope {
  if (!isRecord(value)) {
    throw new Error("Connector request must be an object");
  }
  if (value.protocol !== CONNECTOR_INVOCATION_PROTOCOL) {
    throw new Error(`Unsupported connector protocol: ${String(value.protocol)}`);
  }
  if (!isInvocationKind(value.kind)) {
    throw new Error(`Unsupported connector invocation: ${String(value.kind)}`);
  }
  if (!isInvocationContext(value.context)) {
    throw new Error("Connector request context is invalid");
  }
  assertConnectorJson(value.payload, "payload");
}

export function assertConnectorResponseEnvelope(
  value: unknown,
): asserts value is ConnectorResponseEnvelope {
  if (!isRecord(value)) {
    throw new Error("Connector response must be an object");
  }
  if (value.protocol !== CONNECTOR_INVOCATION_PROTOCOL) {
    throw new Error(`Unsupported connector protocol: ${String(value.protocol)}`);
  }
  if (typeof value.request_id !== "string" || value.request_id.length === 0) {
    throw new Error("Connector response request_id is required");
  }
  if (value.ok === true) {
    assertConnectorJson(value.result, "result");
    return;
  }
  if (value.ok !== false || !isInvocationError(value.error)) {
    throw new Error("Connector response error is invalid");
  }
}

export function assertConnectorStreamDescriptor(
  value: unknown,
): asserts value is ConnectorStreamDescriptor {
  if (!isRecord(value) || !nonEmpty(value.stream_key)) {
    throw new Error("Connector stream_key is required");
  }
  if (value.thread_id !== undefined && typeof value.thread_id !== "string") {
    throw new Error("Connector thread_id must be a string");
  }
  if (value.label !== undefined && typeof value.label !== "string") {
    throw new Error("Connector label must be a string");
  }
  if (value.binding !== undefined) {
    assertConnectorJson(value.binding, "binding");
  }
  if (value.pace !== undefined) {
    if (!isRecord(value.pace)) {
      throw new Error("Connector pace must be an object");
    }
    assertOptionalPositiveInteger(value.pace.idle_ms, "pace.idle_ms");
    assertOptionalPositiveInteger(
      value.pace.catch_up_pages,
      "pace.catch_up_pages",
    );
  }
}

export function assertConnectorJson(
  value: unknown,
  field = "value",
): asserts value is ConnectorJson {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${field} must contain finite numbers`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertConnectorJson(entry, `${field}[${index}]`),
    );
    return;
  }
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) {
        throw new Error(`${field}.${key} must not be undefined`);
      }
      assertConnectorJson(entry, `${field}.${key}`);
    }
    return;
  }
  throw new Error(`${field} must be JSON serializable`);
}

function isInvocationKind(value: unknown): value is ConnectorInvocationKind {
  return (
    value === "describe" ||
    value === "validate_install" ||
    value === "list_directory" ||
    value === "resolve_streams" ||
    value === "poll" ||
    value === "translate_webhook" ||
    value === "send" ||
    value === "lifecycle"
  );
}

function isInvocationContext(
  value: unknown,
): value is ConnectorInvocationContext {
  if (!isRecord(value)) {
    return false;
  }
  return (
    nonEmpty(value.request_id) &&
    nonEmpty(value.installation_id) &&
    nonEmpty(value.connector_type) &&
    optionalString(value.deadline_at) &&
    optionalString(value.cancellation_id) &&
    optionalString(value.idempotency_key)
  );
}

function isInvocationError(value: unknown): value is ConnectorInvocationError {
  if (
    !isRecord(value) ||
    !nonEmpty(value.code) ||
    typeof value.message !== "string" ||
    typeof value.retryable !== "boolean"
  ) {
    return false;
  }
  const retryAfterMs = value.retry_after_ms;
  return (
    retryAfterMs === undefined ||
    (typeof retryAfterMs === "number" &&
      Number.isInteger(retryAfterMs) &&
      retryAfterMs >= 0)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function assertOptionalPositiveInteger(value: unknown, field: string): void {
  if (
    value !== undefined &&
    (!Number.isInteger(value) || Number(value) < 0)
  ) {
    throw new Error(`${field} must be a non-negative integer`);
  }
}
