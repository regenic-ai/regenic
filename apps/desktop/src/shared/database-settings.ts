export type DatabaseDriver = "sqlite" | "postgres";

export interface DatabaseSettingsView {
  driver: DatabaseDriver;
  canChange: boolean;
  hasSavedConnection: boolean;
  connectionLabel?: string;
}

export interface DatabaseSettingsInput {
  driver: DatabaseDriver;
  connectionString?: string;
  confirmed?: boolean;
}

export type DatabaseSettingsResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };
