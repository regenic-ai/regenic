import { createHash } from "node:crypto";
import { Socket } from "node:net";
import { join } from "node:path";
import { Client } from "pg";
import type { DatabaseDriver } from "../shared/database-settings.ts";

export interface DatabasePreference {
  driver: DatabaseDriver;
  encryptedConnection?: string;
  connectionLabel?: string;
  blobKey?: string;
}

export function storedDatabasePreference(raw: unknown): DatabasePreference | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || !("driver" in raw) ||
    (raw.driver !== "sqlite" && raw.driver !== "postgres")) {
    throw new Error("database.invalidDriver");
  }
  const driver = raw.driver;
  const encryptedConnection = "encryptedConnection" in raw ? raw.encryptedConnection : undefined;
  const blobKey = "blobKey" in raw ? raw.blobKey : undefined;
  const connectionLabel = "connectionLabel" in raw ? raw.connectionLabel : undefined;
  if (driver === "postgres" &&
    (typeof encryptedConnection !== "string" || !encryptedConnection ||
      typeof blobKey !== "string" || !/^[a-f0-9]{24}$/.test(blobKey))) {
    throw new Error("database.invalidConnection");
  }
  return {
    driver,
    ...(typeof encryptedConnection === "string" ? { encryptedConnection } : {}),
    ...(typeof blobKey === "string" && /^[a-f0-9]{24}$/.test(blobKey) ? { blobKey } : {}),
    ...(typeof connectionLabel === "string" ? { connectionLabel } : {}),
  };
}

export function postgresConnection(raw: unknown): {
  connectionString: string;
  label: string;
  blobKey: string;
} {
  if (typeof raw !== "string") throw new Error("database.invalidConnection");
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error("database.invalidConnection");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.hostname || url.pathname.length < 2 || url.hash ||
    ["host", "hostaddr", "port", "database", "dbname", "user", "password"].some(
      (key) => url.searchParams.has(key),
    )
  ) {
    throw new Error("database.invalidConnection");
  }
  let databaseName: string;
  try {
    databaseName = decodeURIComponent(url.pathname.slice(1));
    decodeURIComponent(url.username);
    decodeURIComponent(url.password);
  } catch {
    throw new Error("database.invalidConnection");
  }
  if (!url.port) url.port = "5432";
  const identity = `${url.hostname.toLowerCase()}:${url.port}/${databaseName}`;
  return {
    connectionString: url.toString(),
    label: `${url.hostname}:${url.port}/${databaseName}`,
    blobKey: createHash("sha256").update(identity).digest("hex").slice(0, 24),
  };
}

export function databaseEnvironment(
  env: NodeJS.ProcessEnv,
  database: string,
  blobRoot: string,
  dataRoot: string,
  preference?: DatabasePreference,
  connectionString?: string,
): NodeJS.ProcessEnv {
  if (preference?.driver === "postgres") {
    if (!connectionString || !preference.blobKey) {
      throw new Error("database.connectionRequired");
    }
    const next: NodeJS.ProcessEnv = {
      ...env,
      REGENIC_AUTHORITY_DRIVER: "postgres",
      DATABASE_URL: connectionString,
      REGENIC_BLOB_ROOT: join(dataRoot, "postgres", preference.blobKey, "blobs"),
      REGENIC_EMBEDDING_DRIVER: "none",
      REGENIC_START_BACKGROUND: env.REGENIC_START_BACKGROUND ?? "all",
    };
    delete next.REGENIC_DATABASE;
    return next;
  }
  const next: NodeJS.ProcessEnv = {
    ...env,
    REGENIC_AUTHORITY_DRIVER: "sqlite",
    REGENIC_DATABASE: database,
    REGENIC_BLOB_ROOT: blobRoot,
  };
  delete next.DATABASE_URL;
  return next;
}

export async function testPostgresConnection(connectionString: string): Promise<void> {
  const socket = new Socket();
  const client = new Client({
    connectionString,
    stream: () => socket,
    connectionTimeoutMillis: 10_000,
    query_timeout: 10_000,
    statement_timeout: 10_000,
    application_name: "regenic-desktop-connection-test",
  });
  let failed = false;
  const fail = () => {
    failed = true;
    socket.destroy();
  };
  client.on("error", fail);
  // Own the socket so URL parameters cannot extend the deadline, including cleanup.
  const timeout = setTimeout(fail, 10_000);
  try {
    try {
      await client.connect();
      await client.query("SELECT 1");
    } finally {
      await client.end();
    }
    if (failed) throw new Error("database.connectionFailed");
  } catch {
    // Do not expose credentials or server-supplied details through IPC.
    throw new Error("database.connectionFailed");
  } finally {
    clearTimeout(timeout);
    socket.destroy();
  }
}

export async function startDatabaseRuntime(options: {
  database?: DatabasePreference;
  semanticEnabled?: boolean;
  startSemantic: () => Promise<void>;
  startKernel: () => Promise<void>;
  onSemanticError: (error: unknown) => void;
}): Promise<void> {
  if (options.database?.driver !== "postgres" && options.semanticEnabled) {
    try {
      await options.startSemantic();
    } catch (error) {
      options.onSemanticError(error);
    }
  }
  await options.startKernel();
}

export async function switchDatabase<T>(
  previous: T,
  next: T,
  hooks: {
    stop: () => Promise<void>;
    save: (value: T) => void;
    start: () => Promise<void>;
  },
): Promise<void> {
  await hooks.stop();
  try {
    hooks.save(next);
    await hooks.start();
  } catch {
    try {
      await hooks.stop();
      hooks.save(previous);
      await hooks.start();
    } catch {
      throw new Error("database.restoreFailed");
    }
    throw new Error("database.applyFailed");
  }
}
