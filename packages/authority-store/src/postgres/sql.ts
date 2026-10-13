import type {
  PoolClient,
} from "pg";

export interface PgSql {
  query<T>(sql: string, params?: unknown[], client?: PoolClient): Promise<T[]>;
  queryOne<T>(sql: string, params?: unknown[], client?: PoolClient): Promise<T | null>;
  execute(sql: string, params?: unknown[], client?: PoolClient): Promise<number>;
  withTx<T>(fn: (client: PoolClient) => Promise<T>, isolation?: "REPEATABLE READ"): Promise<T>;
}

/** node-pg encodes JS arrays as PG arrays; JSONB columns need JSON text. */
export function jsonb(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function asJson<T>(value: unknown): T {
  if (typeof value === "string") {
    return JSON.parse(value) as T;
  }
  return value as T;
}

export function asBool(value: unknown): boolean {
  return value === true || value === 1 || value === "t" || value === "true";
}

export function asNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

export function toIso(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return String(value);
}

export function toIsoOrNull(value: unknown): string | null {
  if (value == null) {
    return null;
  }
  return toIso(value);
}
