import {
  pushWatermarkPageLimit,
  type ListPushWatermarksQuery,
  type PushWatermark,
  type PushWatermarkSummary,
} from "@regenic/domain";
import { type PgSql, toIso } from "./sql";

interface PushWatermarkRow {
  installation_id: string;
  stream_key: string;
  watermark: string;
  batch_id: string | null;
  updated_at: unknown;
}

export async function recordPushWatermark(db: PgSql, input: PushWatermark): Promise<void> {
  await db.execute(
    `
      INSERT INTO connector_push_watermarks (
        installation_id, stream_key, watermark, batch_id, updated_at
      ) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (installation_id, stream_key) DO UPDATE SET
        watermark = EXCLUDED.watermark,
        batch_id = EXCLUDED.batch_id,
        updated_at = EXCLUDED.updated_at
    `,
    [
      input.installation_id,
      input.stream_key,
      input.watermark,
      input.batch_id ?? null,
      input.updated_at,
    ],
  );
}

export async function listPushWatermarks(
  db: PgSql,
  installationId: string,
  query: ListPushWatermarksQuery = {},
): Promise<PushWatermark[]> {
  if (query.stream_keys?.length === 0) {
    return [];
  }
  const rows = await db.query<PushWatermarkRow>(
    `
      SELECT installation_id, stream_key, watermark, batch_id, updated_at
      FROM connector_push_watermarks
      WHERE installation_id = $1
        AND ($2::text IS NULL OR stream_key > $2)
        AND ($3::text[] IS NULL OR stream_key = ANY($3::text[]))
      ORDER BY stream_key ASC
      LIMIT $4
    `,
    [
      installationId,
      query.after ?? null,
      query.stream_keys ? [...query.stream_keys] : null,
      pushWatermarkPageLimit(query.limit),
    ],
  );
  return rows.map((row) => ({
    installation_id: row.installation_id,
    stream_key: row.stream_key,
    watermark: row.watermark,
    ...(row.batch_id ? { batch_id: row.batch_id } : {}),
    updated_at: toIso(row.updated_at),
  }));
}

export async function summarizePushWatermarks(
  db: PgSql,
  installationId: string,
): Promise<PushWatermarkSummary> {
  const row = await db.queryOne<{ stream_count: unknown; last_updated_at: unknown }>(
    `
      SELECT COUNT(*) AS stream_count, MAX(updated_at) AS last_updated_at
      FROM connector_push_watermarks
      WHERE installation_id = $1
    `,
    [installationId],
  );
  return {
    stream_count: Number(row?.stream_count ?? 0),
    ...(row?.last_updated_at ? { last_updated_at: toIso(row.last_updated_at) } : {}),
  };
}
