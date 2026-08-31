import { randomUUID } from "node:crypto";
import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import {
  ModelTimeoutError,
  ModelUnavailableError,
  ModelUpstreamError,
  type ContextBundle,
  type ContextReplayRequest,
  type ContextRequest,
  type ContextSnapshot,
} from "@regenic/domain";
import {
  ContextEngineError,
  ContextQuestionAnswerer,
  ContextQuestionError,
  type ContextAnswerResult,
} from "@regenic/context-engine";
import { PersonalRuntimeService } from "./personal-runtime.service";

const FORBIDDEN_PERSONAL_KEYS = new Set(["id", "org_id", "principal", "schema_version"]);
const ASK_KEYS = new Set([
  "question",
  "consumer_id",
  "purpose",
  "anchors",
  "filters",
  "temporal",
  "budget",
  "requested_kinds",
]);

export class PersonalContextError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "not_found"
      | "replay_forbidden"
      | "no_context"
      | "model_unavailable"
      | "model_timeout"
      | "model_upstream"
      | "invalid_model_output",
    readonly httpStatus: number,
    message: string,
  ) {
    super(message);
    this.name = "PersonalContextError";
  }
}

@Injectable()
export class PersonalContextService {
  constructor(
    @Inject(PersonalRuntimeService)
    private readonly runtime: PersonalRuntimeService,
  ) {}

  async assemble(input: unknown) {
    const request = this.contextRequest(input);
    return this.runContext(() => this.runtime.requireHost().get("context").assemble(request));
  }

  async getSnapshot(snapshotId: string): Promise<ContextSnapshot> {
    const id = requiredString(snapshotId, "snapshot_id");
    const snapshot = await this.runtime
      .requireHost()
      .get("context-artifacts")
      .getSnapshot(this.runtime.orgId(), id);
    if (!snapshot) {
      throw new PersonalContextError("not_found", HttpStatus.NOT_FOUND, "Context snapshot was not found");
    }
    return snapshot;
  }

  async replay(input: unknown): Promise<ContextBundle> {
    const body = personalBody(input);
    const request = {
      ...body,
      org_id: this.runtime.orgId(),
      principal: this.principal(),
    } as unknown as ContextReplayRequest;
    return this.runContext(() => this.runtime.requireHost().get("context").replay(request));
  }

  async ask(input: unknown): Promise<ContextAnswerResult> {
    const body = strictBody(input, ASK_KEYS);
    const question = requiredString(body.question, "question");
    const request = this.contextRequest({
      consumer_id: body.consumer_id ?? "personal-context-ask",
      purpose: body.purpose ?? "answer an authorized context question",
      allowed_uses: ["display", "reason"],
      query: question,
      anchors: body.anchors,
      filters: body.filters,
      temporal: body.temporal ?? { mode: "current" },
      budget: body.budget ?? {
        profile: "personal-ask-v1",
        max_tokens: 4_000,
        max_items: 20,
        max_raw_evidence: 20,
      },
      requested_kinds: body.requested_kinds ?? ["event"],
    });
    try {
      const host = this.runtime.requireHost();
      return await this.runContext(() => new ContextQuestionAnswerer(
        host.get("context"),
        host.get("model"),
      ).ask(request, question));
    } catch (error) {
      if (error instanceof PersonalContextError) {
        throw error;
      }
      if (error instanceof ContextQuestionError) {
        const status = error.code === "invalid_question"
          ? HttpStatus.BAD_REQUEST
          : error.code === "no_context"
            ? HttpStatus.UNPROCESSABLE_ENTITY
            : HttpStatus.BAD_GATEWAY;
        throw new PersonalContextError(
          error.code === "invalid_question" ? "invalid_request" : error.code,
          status,
          error.message,
        );
      }
      throw modelError(error);
    }
  }

  private contextRequest(input: unknown): ContextRequest {
    const body = personalBody(input);
    return {
      ...body,
      schema_version: "1.0",
      id: randomUUID(),
      org_id: this.runtime.orgId(),
      principal: this.principal(),
    } as unknown as ContextRequest;
  }

  private principal() {
    return { actor_type: "human" as const, actor_id: this.runtime.orgId() };
  }

  private async runContext<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof ContextEngineError)) {
        throw error;
      }
      const status = error.code === "not_found"
        ? HttpStatus.NOT_FOUND
        : error.code === "replay_forbidden"
          ? HttpStatus.FORBIDDEN
          : HttpStatus.BAD_REQUEST;
      throw new PersonalContextError(
        error.code === "not_found" || error.code === "replay_forbidden"
          ? error.code
          : "invalid_request",
        status,
        error.message,
      );
    }
  }
}

function personalBody(input: unknown): Record<string, unknown> {
  const body = asRecord(input);
  for (const key of FORBIDDEN_PERSONAL_KEYS) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      throw new PersonalContextError(
        "invalid_request",
        HttpStatus.BAD_REQUEST,
        `${key} is controlled by the personal authority boundary`,
      );
    }
  }
  return body;
}

function strictBody(input: unknown, allowed: ReadonlySet<string>): Record<string, unknown> {
  const body = personalBody(input);
  const unexpected = Object.keys(body).find((key) => !allowed.has(key));
  if (unexpected) {
    throw new PersonalContextError(
      "invalid_request",
      HttpStatus.BAD_REQUEST,
      `Unexpected field: ${unexpected}`,
    );
  }
  return body;
}

function modelError(error: unknown): PersonalContextError {
  if (error instanceof ModelUnavailableError) {
    return new PersonalContextError(
      "model_unavailable",
      HttpStatus.SERVICE_UNAVAILABLE,
      error.message,
    );
  }
  if (error instanceof ModelTimeoutError) {
    return new PersonalContextError("model_timeout", HttpStatus.GATEWAY_TIMEOUT, error.message);
  }
  if (error instanceof ModelUpstreamError) {
    return new PersonalContextError("model_upstream", HttpStatus.BAD_GATEWAY, error.message);
  }
  return new PersonalContextError(
    "model_upstream",
    HttpStatus.BAD_GATEWAY,
    "Model provider request failed",
  );
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new PersonalContextError(
      "invalid_request",
      HttpStatus.BAD_REQUEST,
      `${name} is required`,
    );
  }
  return value.trim();
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PersonalContextError(
      "invalid_request",
      HttpStatus.BAD_REQUEST,
      "Request body must be an object",
    );
  }
  return value as Record<string, unknown>;
}

