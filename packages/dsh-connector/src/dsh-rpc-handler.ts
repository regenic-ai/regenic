import type { DshHistoryQuery, DshSurfaceEvent } from "./dsh-session-poll-connector";

export const DSH_PUBLIC_METHODS = [
  "session.history",
  "session.prompt",
  "session.list",
  "session.create",
] as const;

export type DshPublicMethod = (typeof DSH_PUBLIC_METHODS)[number];

export interface DshRpcError {
  code: string;
  message: string;
  details: Record<string, unknown>;
}

export interface DshServerResponse {
  type: "server-response";
  rpcId: string;
  result:
    | { ok: true; value: unknown }
    | { ok: false; error: DshRpcError };
}

export interface DshRpcHttpResult {
  status: number;
  body?: DshServerResponse | { error: { code: string; message: string } };
}

export interface DshListedSession {
  sessionId: string;
  status: string;
  installationId: string;
}

export interface DshRpcServices {
  listSessions(): Promise<DshListedSession[]>;
  receive(sessionId: string, query?: DshHistoryQuery): Promise<{
    events: DshSurfaceEvent[];
    hasMore: boolean;
  }>;
  send(sessionId: string, text: string): Promise<{ accepted: true }>;
  createSession(payload?: Record<string, unknown>): Promise<{ sessionId: string }>;
}

export interface DshRpcHttpInput {
  contentType: string | undefined;
  body: unknown;
}

export async function handleDshPublicRpc(
  method: string,
  input: DshRpcHttpInput,
  services: DshRpcServices,
): Promise<DshRpcHttpResult> {
  if (!isJsonContentType(input.contentType)) {
    return {
      status: 415,
      body: {
        error: {
          code: "unsupported_media_type",
          message: "application/json required",
        },
      },
    };
  }
  if (!isPublicMethod(method)) {
    return {
      status: 404,
      body: {
        error: { code: "not_found", message: `Unknown DSH method: ${method}` },
      },
    };
  }
  const envelope = parseClientRequest(input.body, method);
  if (!envelope.ok) {
    return {
      status: 200,
      body: errorResponse(envelope.rpcId, envelope.error),
    };
  }
  try {
    const value = await dispatch(method, envelope.payload, services);
    return {
      status: 200,
      body: {
        type: "server-response",
        rpcId: envelope.rpcId,
        result: { ok: true, value },
      },
    };
  } catch (error) {
    return {
      status: 200,
      body: errorResponse(envelope.rpcId, publicError(error)),
    };
  }
}

async function dispatch(
  method: DshPublicMethod,
  payload: Record<string, unknown>,
  services: DshRpcServices,
): Promise<unknown> {
  if (method === "session.list") {
    return { items: await services.listSessions() };
  }
  if (method === "session.create") {
    return services.createSession(payload);
  }
  const sessionId = requiredSessionId(payload);
  if (method === "session.history") {
    return services.receive(sessionId, historyQuery(payload));
  }
  return services.send(sessionId, textFromPromptPayload(payload));
}

function parseClientRequest(
  body: unknown,
  routeMethod: DshPublicMethod,
):
  | { ok: true; rpcId: string; payload: Record<string, unknown> }
  | { ok: false; rpcId: string; error: DshRpcError } {
  if (!isObject(body)) {
    return {
      ok: false,
      rpcId: "missing",
      error: {
        code: "bad-request",
        message: "Request body must be a JSON object",
        details: {},
      },
    };
  }
  if (typeof body.rpcId !== "string" || body.rpcId.trim().length === 0) {
    return {
      ok: false,
      rpcId: typeof body.rpcId === "string" ? body.rpcId : "missing",
      error: {
        code: "bad-request",
        message: "rpcId is required",
        details: {},
      },
    };
  }
  if (body.type !== undefined && body.type !== "client-request") {
    return {
      ok: false,
      rpcId: body.rpcId,
      error: {
        code: "bad-request",
        message: "type must be client-request",
        details: {},
      },
    };
  }
  if (typeof body.method === "string" && body.method !== routeMethod) {
    return {
      ok: false,
      rpcId: body.rpcId,
      error: {
        code: "bad-request",
        message: "method does not match the route",
        details: {},
      },
    };
  }
  if (body.payload !== undefined && !isObject(body.payload)) {
    return {
      ok: false,
      rpcId: body.rpcId,
      error: {
        code: "bad-request",
        message: "payload must be an object",
        details: {},
      },
    };
  }
  return {
    ok: true,
    rpcId: body.rpcId,
    payload: isObject(body.payload) ? body.payload : {},
  };
}

function historyQuery(payload: Record<string, unknown>): DshHistoryQuery {
  const query: DshHistoryQuery = {};
  if (payload.maxMessages !== undefined) {
    query.maxMessages = requireBoundedInt(payload.maxMessages, "maxMessages", 1, 100);
  }
  if (payload.beforeSeq !== undefined) {
    query.beforeSeq = requireBoundedInt(payload.beforeSeq, "beforeSeq", 0);
  }
  return query;
}

function requireBoundedInt(
  value: unknown,
  name: string,
  min: number,
  max?: number,
): number {
  if (
    typeof value !== "number"
    || !Number.isInteger(value)
    || value < min
    || (max !== undefined && value > max)
  ) {
    throw publicException(
      "bad-request",
      max === undefined
        ? `${name} must be an integer >= ${min}`
        : `${name} must be an integer from ${min} through ${max}`,
    );
  }
  return value;
}

function requiredSessionId(payload: Record<string, unknown>): string {
  if (typeof payload.sessionId !== "string" || payload.sessionId.trim().length === 0) {
    throw publicException("bad-request", "sessionId is required");
  }
  return payload.sessionId;
}

function textFromPromptPayload(payload: Record<string, unknown>): string {
  if (payload.mode !== undefined && payload.mode !== "queue") {
    throw publicException("bad-request", "mode must be queue");
  }
  if (!Array.isArray(payload.content)) {
    throw publicException("bad-request", "content must be an array");
  }
  const text = payload.content
    .flatMap((part) =>
      isObject(part) && part.type === "text" && typeof part.text === "string"
        ? [part.text]
        : [],
    )
    .join("");
  if (text.trim().length === 0) {
    throw publicException("bad-request", "content must include a text part");
  }
  return text;
}

function isJsonContentType(contentType: string | undefined): boolean {
  if (!contentType) {
    return false;
  }
  return contentType.split(";")[0].trim().toLowerCase() === "application/json";
}

function isPublicMethod(method: string): method is DshPublicMethod {
  return (DSH_PUBLIC_METHODS as readonly string[]).includes(method);
}

function errorResponse(rpcId: string, error: DshRpcError): DshServerResponse {
  return {
    type: "server-response",
    rpcId,
    result: { ok: false, error },
  };
}

function publicError(error: unknown): DshRpcError {
  if (isPublicException(error)) {
    return error.error;
  }
  if (isObject(error) && typeof error.code === "string" && typeof error.message === "string") {
    return { code: error.code, message: error.message, details: {} };
  }
  return {
    code: "internal",
    message: error instanceof Error ? error.message : "DSH request failed",
    details: {},
  };
}

class DshPublicException extends Error {
  constructor(readonly error: DshRpcError) {
    super(error.message);
    this.name = "DshPublicException";
  }
}

function publicException(code: string, message: string): DshPublicException {
  return new DshPublicException({ code, message, details: {} });
}

function isPublicException(error: unknown): error is DshPublicException {
  return error instanceof DshPublicException;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
