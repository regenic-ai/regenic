import { z } from "zod";
import type {
  ConnectorLimits,
  IngestRecord,
  IngestRecordResult,
} from "./ingest";
import { IngestRecordSchema, type IngestValidationIssue } from "./ingest-schema";

export const PUSH_INGEST_MAX_EVENTS = 500;

/**
 * Connector → core push of new records for one stream. Delivery is
 * at-least-once: replaying a batch is safe because core dedupes on the
 * record source identity (`source`, `external_id`).
 */
export interface PushIngestBatch {
  stream_key: string;
  /** Connector-chosen delivery id. Replays should reuse it. */
  batch_id?: string;
  events: IngestRecord[];
  /** Opaque connector position after the last event. Core never interprets it. */
  watermark?: string;
  /**
   * Connector still has attachment downloads queued for this stream.
   * Core schedules the media lane only when the install can be polled and
   * the ack has no retryable failure. Omit to leave the stored flag.
   */
  media_pending?: boolean;
}

/**
 * Returned only after every event is durable or definitively rejected.
 * `watermark` is echoed when no event needs a retry, so the connector may
 * drop the batch from its outbox and advance its own position.
 */
export interface PushIngestAck {
  installation_id: string;
  stream_key: string;
  batch_id: string;
  accepted_count: number;
  duplicate_count: number;
  quarantined_count: number;
  retryable_count: number;
  records: IngestRecordResult[];
  watermark?: string;
}

/**
 * Last watermark core acked for one stream. Last write wins: a replayed older
 * batch can move it back, which only causes duplicate pushes, never gaps.
 */
export interface PushWatermark {
  installation_id: string;
  stream_key: string;
  watermark: string;
  batch_id?: string;
  updated_at: string;
}

export interface PushWatermarkPage {
  watermarks: PushWatermark[];
  /** Pass as `after` for the next page; absent on the last page. */
  next_after?: string;
}

export const PUSH_WATERMARK_PAGE_MAX = 500;

export interface PushWatermarkQuery {
  stream_keys?: readonly string[];
  /** Exclusive `stream_key` cursor from `PushWatermarkPage.next_after`. */
  after?: string;
  limit?: number;
}

/** Bound to one installation; `push` goes through the same gate as HTTP. */
export interface PushReconcileContext {
  signal: AbortSignal;
  listWatermarks(query?: PushWatermarkQuery): Promise<PushWatermarkPage>;
  push(batch: PushIngestBatch): Promise<PushIngestAck>;
}

export interface PushReconcileReport {
  repushed_batches?: number;
}

const boundedString = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.trim().length > 0, "String cannot be blank");

export const PushIngestBatchSchema: z.ZodType<PushIngestBatch> = z
  .object({
    stream_key: boundedString(512),
    batch_id: boundedString(256).optional(),
    events: z.array(IngestRecordSchema).min(1).max(PUSH_INGEST_MAX_EVENTS),
    watermark: boundedString(4096).optional(),
    media_pending: z.boolean().optional(),
  })
  .strict();

export type PushIngestValidationResult =
  | { success: true; data: PushIngestBatch }
  | {
      success: false;
      error_code: "invalid_envelope" | "invalid_record";
      issues: IngestValidationIssue[];
    };

export function validatePushIngestBatch(input: unknown): PushIngestValidationResult {
  const result = PushIngestBatchSchema.safeParse(input);
  if (result.success) {
    return { success: true, data: result.data };
  }
  const issues = zodIssues(result.error);
  const hasRecordIssue = issues.some(
    (issue) => issue.path[0] === "events" && typeof issue.path[1] === "number",
  );
  return {
    success: false,
    error_code: hasRecordIssue ? "invalid_record" : "invalid_envelope",
    issues,
  };
}

export const CONNECTOR_LIMIT_RANGES = {
  max_concurrency: [1, 64],
  page_size: [1, 1_000],
  rate_tokens: [0, 10_000],
  rate_window_ms: [1_000, 3_600_000],
} as const;

const integerIn = ([min, max]: readonly [number, number]) =>
  z.number().int().min(min).max(max);

export const ConnectorLimitsSchema: z.ZodType<ConnectorLimits> = z
  .object({
    max_concurrency: integerIn(CONNECTOR_LIMIT_RANGES.max_concurrency).optional(),
    page_size: integerIn(CONNECTOR_LIMIT_RANGES.page_size).optional(),
    rate: z
      .object({
        tokens: integerIn(CONNECTOR_LIMIT_RANGES.rate_tokens),
        window_ms: integerIn(CONNECTOR_LIMIT_RANGES.rate_window_ms),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ConnectorLimitsValidationResult =
  | { success: true; data: ConnectorLimits }
  | { success: false; issues: IngestValidationIssue[] };

export function validateConnectorLimits(input: unknown): ConnectorLimitsValidationResult {
  const result = ConnectorLimitsSchema.safeParse(input);
  return result.success
    ? { success: true, data: result.data }
    : { success: false, issues: zodIssues(result.error) };
}

/** Drops out-of-range declared fields instead of failing a connector at load. */
export function sanitizeConnectorLimits(
  input: ConnectorLimits | null | undefined,
): ConnectorLimits | undefined {
  if (!input) {
    return undefined;
  }
  const out: ConnectorLimits = {};
  for (const key of ["max_concurrency", "page_size"] as const) {
    const parsed = integerIn(CONNECTOR_LIMIT_RANGES[key]).safeParse(input[key]);
    if (parsed.success) {
      out[key] = parsed.data;
    }
  }
  const rate = ConnectorLimitsSchema.safeParse({ rate: input.rate });
  if (input.rate && rate.success && rate.data.rate) {
    out.rate = rate.data.rate;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function zodIssues(error: z.ZodError): IngestValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map((part) => typeof part === "symbol" ? String(part) : part),
    message: issue.message,
  }));
}
