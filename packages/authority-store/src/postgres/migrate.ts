import type { Pool } from "pg";
import { PG_BASELINE_SQL, PG_SCHEMA_VERSION } from "./schema";

export async function migratePostgresAuthority(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL
      )
    `);
    const current = await client.query<{ version: string | number }>(
      `SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations`,
    );
    const currentVersion = Number(current.rows[0]?.version ?? 0);
    if (currentVersion > PG_SCHEMA_VERSION) {
      throw new Error(
        `Authority database schema ${currentVersion} is newer than supported ${PG_SCHEMA_VERSION}`,
      );
    }
    if (currentVersion === PG_SCHEMA_VERSION) {
      await client.query("COMMIT");
      return;
    }
    if (currentVersion !== 0) {
      throw new Error(
        `Authority postgres schema ${currentVersion} cannot jump to ${PG_SCHEMA_VERSION}`,
      );
    }
    await client.query(PG_BASELINE_SQL);
    await client.query(
      `INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)`,
      [PG_SCHEMA_VERSION, new Date().toISOString()],
    );
    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Keep the original error if rollback fails.
    }
    throw error;
  } finally {
    client.release();
  }
}
