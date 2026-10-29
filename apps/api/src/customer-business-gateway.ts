import { randomUUID } from "node:crypto";
import {
  validateBusinessEvidence,
  type BusinessEntityResult,
  type BusinessEvidence,
} from "@regenic/domain";
import {
  CustomerServiceError,
  customerBusinessCitation,
  type CustomerBusinessGateway,
  type CustomerBusinessQuery,
} from "@regenic/context-engine";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export interface HttpCustomerBusinessGatewayOptions {
  url: string;
  token?: string;
  timeout_ms?: number;
  fetch?: typeof fetch;
}

export class HttpCustomerBusinessGateway implements CustomerBusinessGateway {
  readonly id: string;
  private readonly url: URL;
  private readonly fetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: HttpCustomerBusinessGatewayOptions) {
    this.url = safeBusinessUrl(options.url);
    this.id = `http:${this.url.origin}${this.url.pathname}`;
    this.fetch = options.fetch ?? fetch;
    this.timeoutMs = boundedTimeout(options.timeout_ms ?? DEFAULT_TIMEOUT_MS);
  }

  async query(input: CustomerBusinessQuery): Promise<BusinessEvidence> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(this.url, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...(this.options.token?.trim()
            ? { authorization: `Bearer ${this.options.token.trim()}` }
            : {}),
        },
        body: JSON.stringify({
          schema_version: "1.0",
          customer_id: input.customer_id,
          project_id: input.project_id,
          batch_id: input.batch_id,
          members: input.members,
          fields: input.fields,
          query_at: input.query_at,
          ...(input.page ? { page: input.page } : {}),
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new CustomerServiceError(
          "business_unavailable",
          `Business query failed with HTTP ${response.status}`,
        );
      }
      const length = Number(response.headers.get("content-length") ?? "0");
      if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
        throw new CustomerServiceError("business_unavailable", "Business query response is too large");
      }
      const text = await readBoundedBody(response, MAX_RESPONSE_BYTES);
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        throw new CustomerServiceError("business_unavailable", "Business query returned invalid JSON");
      }
      const parsed = parseResponse(body, input);
      const queryId = randomQueryId(input, parsed.queried_at);
      return validateBusinessEvidence({
        citation_id: customerBusinessCitation(queryId),
        query_id: queryId,
        task_id: input.task_id,
        brief_version: input.brief_version,
        provider_id: this.id,
        customer_id: input.customer_id,
        project_id: input.project_id,
        batch_id: input.batch_id,
        requested_fields: [...input.fields],
        queried_at: parsed.queried_at,
        complete: parsed.complete,
        ...(parsed.next_page ? { next_page: parsed.next_page } : {}),
        results: parsed.results,
      });
    } catch (error) {
      if (error instanceof CustomerServiceError) {
        throw error;
      }
      const message = error instanceof Error && error.name === "AbortError"
        ? "Business query timed out"
        : "Business query connection failed";
      throw new CustomerServiceError("business_unavailable", message);
    } finally {
      clearTimeout(timer);
    }
  }
}

async function readBoundedBody(response: Response, maximumBytes: number): Promise<string> {
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel();
        throw new CustomerServiceError("business_unavailable", "Business query response is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) =>
    Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)), size).toString("utf8");
}

export class UnconfiguredCustomerBusinessGateway implements CustomerBusinessGateway {
  readonly id = "unconfigured";

  async query(): Promise<BusinessEvidence> {
    throw new CustomerServiceError(
      "business_unavailable",
      "REGENIC_CUSTOMER_BUSINESS_URL is required for customer business queries",
    );
  }
}

export function customerBusinessGatewayFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): CustomerBusinessGateway {
  const url = env.REGENIC_CUSTOMER_BUSINESS_URL?.trim();
  if (!url) return new UnconfiguredCustomerBusinessGateway();
  return new HttpCustomerBusinessGateway({
    url,
    token: env.REGENIC_CUSTOMER_BUSINESS_TOKEN,
    timeout_ms: optionalInteger(env.REGENIC_CUSTOMER_BUSINESS_TIMEOUT_MS),
  });
}

function parseResponse(body: unknown, input: CustomerBusinessQuery): {
  queried_at: string;
  complete: boolean;
  next_page?: string;
  results: BusinessEntityResult[];
} {
  const object = asObject(body);
  rejectUnknown(object, new Set(["schema_version", "queried_at", "complete", "next_page", "results"]));
  if (object.schema_version !== "1.0"
    || typeof object.complete !== "boolean"
    || !Array.isArray(object.results)) {
    throw new CustomerServiceError("business_unavailable", "Business query response has an invalid contract");
  }
  const queriedAt = isoTimestamp(object.queried_at, "queried_at");
  const allowedMembers = new Map(input.members.map((member) => [member.member_key, member.business_id]));
  const results = object.results.map((value) =>
    parseResult(value, allowedMembers, new Set(input.fields)));
  if (new Set(results.map((result) => result.member_key)).size !== results.length) {
    throw new CustomerServiceError("business_unavailable", "Business query returned duplicate member results");
  }
  const nextPage = optionalString(object.next_page);
  if (object.complete && nextPage) {
    throw new CustomerServiceError("business_unavailable", "Complete business result cannot include next_page");
  }
  return {
    queried_at: queriedAt,
    complete: object.complete,
    ...(nextPage ? { next_page: nextPage } : {}),
    results,
  };
}

function parseResult(
  value: unknown,
  allowedMembers: Map<string, string>,
  allowedFields: Set<string>,
): BusinessEntityResult {
  const object = asObject(value);
  rejectUnknown(object, new Set([
    "member_key",
    "business_id",
    "status",
    "record_id",
    "record_version",
    "fields",
    "reason_code",
  ]));
  const memberKey = stringValue(object.member_key, "member_key");
  const businessId = stringValue(object.business_id, "business_id");
  if (allowedMembers.get(memberKey) !== businessId) {
    throw new CustomerServiceError("business_unavailable", "Business query returned an unrequested member");
  }
  const status = object.status;
  if (!["found", "not_found", "ambiguous", "permission_denied", "unavailable"].includes(String(status))) {
    throw new CustomerServiceError("business_unavailable", "Business query returned an invalid result status");
  }
  if (!Array.isArray(object.fields)) {
    throw new CustomerServiceError("business_unavailable", "Business query result fields must be an array");
  }
  const fields = object.fields.map((field) => {
    const item = asObject(field);
    rejectUnknown(item, new Set(["field", "value", "visibility", "authority", "updated_at"]));
    const name = stringValue(item.field, "field");
    if (!allowedFields.has(name)) {
      throw new CustomerServiceError("business_unavailable", "Business query returned an unrequested field");
    }
    if (item.value !== null && !["string", "number", "boolean"].includes(typeof item.value)) {
      throw new CustomerServiceError("business_unavailable", "Business field value must be scalar");
    }
    if (!["customer", "internal", "restricted"].includes(String(item.visibility))) {
      throw new CustomerServiceError("business_unavailable", "Business field visibility is invalid");
    }
    return {
      field: name,
      value: item.value as string | number | boolean | null,
      visibility: item.visibility as "customer" | "internal" | "restricted",
      authority: stringValue(item.authority, "authority"),
      updated_at: isoTimestamp(item.updated_at, "updated_at"),
    };
  });
  return {
    member_key: memberKey,
    business_id: businessId,
    status: status as BusinessEntityResult["status"],
    ...(optionalString(object.record_id) ? { record_id: optionalString(object.record_id) } : {}),
    ...(optionalString(object.record_version) ? { record_version: optionalString(object.record_version) } : {}),
    fields,
    ...(optionalString(object.reason_code) ? { reason_code: optionalString(object.reason_code) } : {}),
  };
}

function safeBusinessUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("REGENIC_CUSTOMER_BUSINESS_URL must be an absolute URL");
  }
  if (url.username || url.password || url.hash || url.search) {
    throw new Error("Business URL must not include credentials, query or fragment");
  }
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Business URL must use HTTPS, except for loopback development");
  }
  return url;
}

function randomQueryId(input: CustomerBusinessQuery, queriedAt: string): string {
  const random = randomUUID();
  return `business-query:${input.task_id}:${input.brief_version}:${queriedAt}:${random}`;
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CustomerServiceError("business_unavailable", "Business query response must be an object");
  }
  return value as Record<string, unknown>;
}

function rejectUnknown(value: Record<string, unknown>, allowed: Set<string>): void {
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new CustomerServiceError("business_unavailable", "Business query response contains unknown fields");
  }
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new CustomerServiceError("business_unavailable", `Business ${field} is required`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isoTimestamp(value: unknown, field: string): string {
  const text = stringValue(value, field);
  if (Number.isNaN(Date.parse(text))) {
    throw new CustomerServiceError("business_unavailable", `Business ${field} must be an ISO timestamp`);
  }
  return text;
}

function boundedTimeout(value: number): number {
  if (!Number.isInteger(value) || value < 100 || value > 60_000) {
    throw new Error("Business timeout must be an integer from 100 to 60000 milliseconds");
  }
  return value;
}

function optionalInteger(value: string | undefined): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new Error("REGENIC_CUSTOMER_BUSINESS_TIMEOUT_MS must be an integer");
  }
  return parsed;
}
