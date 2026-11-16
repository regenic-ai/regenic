import {
  pushWatermarkPageLimit,
  type ListPushWatermarksQuery,
  type PushWatermark,
  type PushWatermarkSummary,
} from "@regenic/domain";
import Database from "better-sqlite3";

interface PushWatermarkRow {
  installation_id: string;
  stream_key: string;
  watermark: string;
  batch_id: string | null;
  updated_at: string;
}

export async function recordPushWatermark(
  db: Database.Database,
  input: PushWatermark,
): Promise<void> {
  db.prepare(
    `
      INSERT INTO connector_push_watermarks (
        installation_id, stream_key, watermark, batch_id, updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(installation_id, stream_key) DO UPDATE SET
        watermark = excluded.watermark,
        batch_id = excluded.batch_id,
        updated_at = excluded.updated_at
    `,
  ).run(
    input.installation_id,
    input.stream_key,
    input.watermark,
    input.batch_id ?? null,
    input.updated_at,
  );
}

export async function listPushWatermarks(
  db: Database.Database,
  installationId: string,
  query: ListPushWatermarksQuery = {},
): Promise<PushWatermark[]> {
  const params: unknown[] = [installationId];
  let where = "installation_id = ?";
  if (query.after !== undefined) {
    where += " AND stream_key > ?";
    params.push(query.after);
  }
  if (query.stream_keys) {
    if (query.stream_keys.length === 0) {
      return [];
    }
    where += ` AND stream_key IN (${query.stream_keys.map(() => "?").join(", ")})`;
    params.push(...query.stream_keys);
  }
  params.push(pushWatermarkPageLimit(query.limit));
  const rows = db
    .prepare(
      `
        SELECT installation_id, stream_key, watermark, batch_id, updated_at
        FROM connector_push_watermarks
        WHERE ${where}
        ORDER BY stream_key ASC
        LIMIT ?
      `,
    )
    .all(...params) as PushWatermarkRow[];
  return rows.map(toPushWatermark);
}

export async function summarizePushWatermarks(
  db: Database.Database,
  installationId: string,
): Promise<PushWatermarkSummary> {
  const row = db
    .prepare(
      `
        SELECT COUNT(*) AS stream_count, MAX(updated_at) AS last_updated_at
        FROM connector_push_watermarks
        WHERE installation_id = ?
      `,
    )
    .get(installationId) as { stream_count: number; last_updated_at: string | null };
  return {
    stream_count: Number(row.stream_count),
    ...(row.last_updated_at ? { last_updated_at: row.last_updated_at } : {}),
  };
}

function toPushWatermark(row: PushWatermarkRow): PushWatermark {
  return {
    installation_id: row.installation_id,
    stream_key: row.stream_key,
    watermark: row.watermark,
    ...(row.batch_id ? { batch_id: row.batch_id } : {}),
    updated_at: row.updated_at,
  };
}
