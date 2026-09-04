import type { Pool } from "pg";
import {
  PG_BASELINE_SQL,
  PG_MIGRATIONS,
  PG_SCHEMA_VERSION,
} from "./schema";

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
    let version = Number(current.rows[0]?.version ?? 0);
    if (version > PG_SCHEMA_VERSION) {
      throw new Error(
        `Authority database schema ${version} is newer than supported ${PG_SCHEMA_VERSION}`,
      );
    }
    if (version === PG_SCHEMA_VERSION) {
      await client.query("COMMIT");
      return;
    }
    const appliedAt = new Date().toISOString();
    if (version === 0) {
      await client.query(PG_BASELINE_SQL);
      await client.query(
        `INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)`,
        [PG_SCHEMA_VERSION, appliedAt],
      );
      await client.query("COMMIT");
      return;
    }
    for (const step of PG_MIGRATIONS) {
      if (step.version <= version) {
        continue;
      }
      if (step.version !== version + 1) {
        throw new Error(
          `Authority postgres schema ${version} cannot jump to ${PG_SCHEMA_VERSION}`,
        );
      }
      for (const statement of step.sql
        .split(";")
        .map((part) => part.trim())
        .filter((part) => part.length > 0)) {
        await client.query(statement);
      }
      await client.query(
        `INSERT INTO schema_migrations (version, applied_at) VALUES ($1, $2)`,
        [step.version, appliedAt],
      );
      version = step.version;
    }
    if (version !== PG_SCHEMA_VERSION) {
      throw new Error(
        `Authority postgres schema ${version} cannot jump to ${PG_SCHEMA_VERSION}`,
      );
    }
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
