import type { PgSql } from "./sql";

export async function getUiPref(
  db: PgSql,
  orgId: string,
  key: string,
): Promise<string | null> {
  const row = await db.queryOne<{ value: string }>(
    `SELECT value FROM ui_prefs WHERE org_id = $1 AND key = $2`,
    [orgId, key],
  );
  return row?.value ?? null;
}

export async function putUiPref(
  db: PgSql,
  orgId: string,
  key: string,
  value: string,
  updatedAt: string,
): Promise<void> {
  await db.execute(
    `
      INSERT INTO ui_prefs (org_id, key, value, updated_at)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (org_id, key) DO UPDATE SET
        value = EXCLUDED.value,
        updated_at = EXCLUDED.updated_at
    `,
    [orgId, key, value, updatedAt],
  );
}
