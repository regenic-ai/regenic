import Database from "better-sqlite3";

export async function getUiPref(
  db: Database.Database,
  orgId: string,
  key: string,
): Promise<string | null> {
  const row = db
    .prepare(`SELECT value FROM ui_prefs WHERE org_id = ? AND key = ?`)
    .get(orgId, key) as { value: string } | undefined;
  return row?.value ?? null;
}

export async function putUiPref(
  db: Database.Database,
  orgId: string,
  key: string,
  value: string,
  updatedAt: string,
): Promise<void> {
  db.prepare(
    `
      INSERT INTO ui_prefs (org_id, key, value, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(org_id, key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `,
  ).run(orgId, key, value, updatedAt);
}
