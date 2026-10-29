import { dirname, join } from "node:path";
import { INGEST_ATTEMPT_KEEP_PER_INSTALLATION } from "@regenic/authority-store";
import {
  ConnectorRunner,
  type JsonValue,
} from "@regenic/domain";
import {
  dshSessionKey,
  dshSessionPlugin,
  dshSessionPluginConfigFromInstallation,
  dshStreamKey,
  type DshFetch,
  type DshSpawn,
} from "@regenic/dsh-connector";
import {
  optionPath,
  optionString,
  requireOption,
  requirePath,
  requirePositiveInteger,
  writeJson,
  type CliOutput,
  type CommandOptions,
} from "../cli-runtime";
import { withLocalHost } from "../host";

export async function installDsh(
  options: CommandOptions,
  stdout: CliOutput,
  now: () => string,
  createId: () => string,
): Promise<void> {
  const orgId = requireOption(options, "org");
  const database = requirePath(options, "database");
  const id = optionString(options, "id") ?? createId();
  const transport = requireOption(options, "transport");
  if (transport !== "web" && transport !== "cli") {
    throw new Error("--transport must be web or cli");
  }
  const config = transport === "web"
    ? {
        transport,
        session_id: requireOption(options, "session"),
        base_url: optionString(options, "base-url") ?? "http://127.0.0.1:3080",
      }
    : cliInstallConfig(options, database, id);
  await withLocalHost({ database }, async (host) => {
    writeJson(stdout, await host.get("authority").createInstallation({
      id,
      org_id: orgId,
      connector_type: "dsh-session",
      status: "enabled",
      config,
      created_at: now(),
    }));
  });
}

function cliInstallConfig(
  options: CommandOptions,
  database: string,
  id: string,
): Record<string, JsonValue> {
  const config: Record<string, JsonValue> = {
    transport: "cli",
    mailbox: optionString(options, "mailbox") ?? id,
    command: optionString(options, "command") ?? "dsh",
    profile: optionString(options, "profile") ?? "headless",
    run_log: optionPath(options, "run-log")
      ?? join(dirname(database), "dsh-runs", `${id}.jsonl`),
  };
  const workdir = optionPath(options, "workdir");
  if (workdir) {
    config.workdir = workdir;
  }
  const patch = optionPath(options, "patch");
  if (patch) {
    config.patch = patch;
  }
  const timeoutMs = optionString(options, "timeout-ms");
  if (timeoutMs) {
    config.timeout_ms = Number(timeoutMs);
  }
  return config;
}

export async function syncDsh(
  options: CommandOptions,
  env: NodeJS.ProcessEnv,
  stdout: CliOutput,
  now: () => string,
  createId: () => string,
  spawn?: DshSpawn,
  fetchOverride?: DshFetch,
): Promise<void> {
  const installationId = requireOption(options, "installation");
  await withLocalHost({
    database: requirePath(options, "database"),
    blobRoot: requirePath(options, "blob-root"),
  }, async (host) => {
    const store = host.get("authority");
    const installation = await store.findInstallation(installationId);
    if (!installation || installation.connector_type !== "dsh-session") {
      throw new Error(`DSH installation not found: ${installationId}`);
    }
    if (installation.status !== "enabled") {
      throw new Error(`DSH installation is disabled: ${installationId}`);
    }
    const sessionKey = dshSessionKey(installation.config, installation.id);
    await host.plugin(
      dshSessionPlugin,
      dshSessionPluginConfigFromInstallation(installation, {
        env,
        spawn,
        fetch: fetchOverride,
        access_token: env.REGENIC_DSH_TOKEN,
        now,
        createId,
      }),
    );
    const connector = host.get("connectors").get(
      installation.id,
      dshStreamKey(sessionKey),
    );
    if (!connector) {
      throw new Error(`DSH connector failed to mount: ${installationId}`);
    }
    const runner = new ConnectorRunner(connector, host.get("ingest"), store, now);
    const maxPages = requirePositiveInteger(options, "max-pages", 1);
    const runs = [];
    const seenCursors = new Set<string>();
    let caughtUp = false;
    for (let page = 0; page < maxPages; page += 1) {
      const run = await runner.poll({
        installation_id: installation.id,
        stream_key: `session:${sessionKey}`,
        lease_owner: `local-cli:${createId()}`,
        lease_duration_ms: 60_000,
      });
      runs.push(run);
      if (run.status !== "completed" || !run.next_cursor) {
        break;
      }
      if (seenCursors.has(run.next_cursor)) {
        caughtUp = true;
        break;
      }
      seenCursors.add(run.next_cursor);
    }
    const lastRun = runs.at(-1);
    writeJson(stdout, {
      pages_attempted: runs.length,
      stopped_at_page_limit:
        !caughtUp &&
        runs.length === maxPages &&
        lastRun?.status === "completed" &&
        lastRun.next_cursor !== undefined,
      runs,
    });
  });
}

export async function sendDsh(
  options: CommandOptions,
  env: NodeJS.ProcessEnv,
  stdout: CliOutput,
  now: () => string,
  createId: () => string,
  spawn?: DshSpawn,
  fetchOverride?: DshFetch,
): Promise<void> {
  const installationId = requireOption(options, "installation");
  const text = requireOption(options, "text");
  await withLocalHost({ database: requirePath(options, "database") }, async (host) => {
    const store = host.get("authority");
    const installation = await store.findInstallation(installationId);
    if (!installation || installation.connector_type !== "dsh-session") {
      throw new Error(`DSH installation not found: ${installationId}`);
    }
    if (installation.status !== "enabled") {
      throw new Error(`DSH installation is disabled: ${installationId}`);
    }
    await host.plugin(
      dshSessionPlugin,
      dshSessionPluginConfigFromInstallation(installation, {
        env,
        spawn,
        fetch: fetchOverride,
        access_token: env.REGENIC_DSH_TOKEN,
        now,
        createId,
      }),
    );
    const egress = host.get("egress").get(
      installation.id,
      dshStreamKey(dshSessionKey(installation.config, installation.id)),
    );
    if (!egress) {
      throw new Error(`DSH egress adapter failed to mount: ${installationId}`);
    }
    writeJson(stdout, await egress.send({
      installation_id: installation.id,
      content: [{ role: "body", media_type: "text/plain", text }],
    }));
  });
}

export async function showStatus(options: CommandOptions, stdout: CliOutput): Promise<void> {
  await withLocalHost({ database: requirePath(options, "database") }, async (host) => {
    const store = host.get("authority");
    writeJson(stdout, await Promise.all(
      (await store.listInstallations(requireOption(options, "org"))).map(async (installation) => ({
        installation,
        attempts: await store.listAttempts(
          installation.id,
          INGEST_ATTEMPT_KEEP_PER_INSTALLATION,
        ),
      })),
    ));
  });
}

export async function showQuarantines(options: CommandOptions, stdout: CliOutput): Promise<void> {
  await withLocalHost({ database: requirePath(options, "database") }, async (host) => {
    writeJson(stdout, await host.get("authority").listQuarantines(requireOption(options, "installation")));
  });
}

export async function setConnectorStatus(
  options: CommandOptions,
  stdout: CliOutput,
  now: () => string,
  status: "enabled" | "disabled",
): Promise<void> {
  await withLocalHost({ database: requirePath(options, "database") }, async (host) => {
    const installation = await host.get("authority").setInstallationStatus({
      id: requireOption(options, "installation"),
      org_id: requireOption(options, "org"),
      status,
      updated_at: now(),
    });
    if (!installation) {
      throw new Error("Connector installation was not found in this organization");
    }
    writeJson(stdout, installation);
  });
}

export async function resetConnectorCursor(
  options: CommandOptions,
  stdout: CliOutput,
  now: () => string,
): Promise<void> {
  await withLocalHost({ database: requirePath(options, "database") }, async (host) => {
    const store = host.get("authority");
    const installationId = requireOption(options, "installation");
    const installation = await store.findInstallation(installationId);
    if (!installation || installation.org_id !== requireOption(options, "org")) {
      throw new Error("Connector installation was not found in this organization");
    }
    const cursor = await store.resetCursor({
      installation_id: installationId,
      stream_key: requireOption(options, "stream"),
      now: now(),
    });
    if (!cursor) {
      throw new Error("Connector stream cursor was not found");
    }
    writeJson(stdout, cursor);
  });
}
