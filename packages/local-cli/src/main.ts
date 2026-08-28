import { randomUUID } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { INGEST_ATTEMPT_KEEP_PER_INSTALLATION } from "@regenic/authority-store";
import {
  ConnectorRunner,
  envCredentialsRef,
  requireEnvCredentialName,
  type ContextConsumer,
  createGenericImport,
  EVIDENCE_BUNDLE_SCHEMA_VERSION,
  type EvidenceBundle,
  type GenericImportDefaults,
  type GenericImportFormat,
  type GenericImportMapping,
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
import { slackChannelPlugin, type SlackFetch } from "@regenic/slack-connector";
import {
  createPurrWhatsAppImport,
  createWhatsAppPersonalImport,
  WHATSAPP_PERSONAL_SOURCE,
} from "@regenic/whatsapp-personal";
import { withLocalHost } from "./host";

interface CliOutput {
  write(chunk: string): boolean;
}

export interface LocalCliOptions {
  env?: NodeJS.ProcessEnv;
  stdout?: CliOutput;
  fetch?: SlackFetch | DshFetch;
  spawn?: DshSpawn;
  now?: () => string;
  createId?: () => string;
}

interface CommandOptions {
  [name: string]: string | boolean;
}

class JsonlContextConsumer implements ContextConsumer {
  constructor(private readonly output: string) {}

  async publish(bundle: EvidenceBundle): Promise<void> {
    await appendFile(this.output, `${JSON.stringify(bundle)}\n`, "utf8");
  }
}

export async function runLocalCli(
  args: string[],
  options: LocalCliOptions = {},
): Promise<void> {
  const [command, ...rest] = args;
  const commandOptions = parseOptions(rest);
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const now = options.now ?? (() => new Date().toISOString());
  const createId = options.createId ?? randomUUID;

  switch (command) {
    case "slack-install":
      await installSlack(commandOptions, stdout, now, createId);
      return;
    case "slack-sync":
      await syncSlack(commandOptions, env, stdout, now, createId, options.fetch as SlackFetch | undefined);
      return;
    case "dsh-install":
      await installDsh(commandOptions, stdout, now, createId);
      return;
    case "dsh-sync":
      await syncDsh(commandOptions, env, stdout, now, createId, options.spawn, options.fetch as DshFetch | undefined);
      return;
    case "dsh-send":
      await sendDsh(commandOptions, env, stdout, now, createId, options.spawn, options.fetch as DshFetch | undefined);
      return;
    case "status":
      await showStatus(commandOptions, stdout);
      return;
    case "quarantines":
      await showQuarantines(commandOptions, stdout);
      return;
    case "import-file":
      await importFile(commandOptions, stdout, now);
      return;
    case "whatsapp-import":
      await importWhatsAppPersonal(commandOptions, stdout, now);
      return;
    case "export-jsonl":
      await exportJsonl(commandOptions, stdout);
      return;
    case "render-digest":
      await renderDigest(commandOptions, stdout);
      return;
    case "connector-enable":
      await setConnectorStatus(commandOptions, stdout, now, "enabled");
      return;
    case "connector-disable":
      await setConnectorStatus(commandOptions, stdout, now, "disabled");
      return;
    case "reset-cursor":
      await resetConnectorCursor(commandOptions, stdout, now);
      return;
    case "publish-evidence-bundle":
      await publishEvidenceBundle(commandOptions, stdout, now, createId);
      return;
    case "inbox":
      await showInbox(commandOptions, stdout);
      return;
    default:
      throw new Error("Command must be one of: slack-install, slack-sync, dsh-install, dsh-sync, dsh-send, status, quarantines, import-file, whatsapp-import, export-jsonl, render-digest, connector-enable, connector-disable, reset-cursor, publish-evidence-bundle, inbox");
  }
}

async function installSlack(
  options: CommandOptions,
  stdout: CliOutput,
  now: () => string,
  createId: () => string,
): Promise<void> {
  const orgId = requireOption(options, "org");
  const channelId = requireOption(options, "channel");
  const tokenEnv = optionString(options, "token-env") ?? "REGENIC_SLACK_TOKEN";
  await withLocalHost({ database: requirePath(options, "database") }, async (host) => {
    writeJson(stdout, await host.get("authority").createInstallation({
      id: optionString(options, "id") ?? createId(),
      org_id: orgId,
      connector_type: "slack-channel",
      status: "enabled",
      config: slackConfig(channelId, optionString(options, "channel-name")),
      credentials_ref: envCredentialsRef(tokenEnv),
      created_at: now(),
    }));
  });
}

async function syncSlack(
  options: CommandOptions,
  env: NodeJS.ProcessEnv,
  stdout: CliOutput,
  now: () => string,
  createId: () => string,
  fetchOverride?: SlackFetch,
): Promise<void> {
  const installationId = requireOption(options, "installation");
  await withLocalHost({
    database: requirePath(options, "database"),
    blobRoot: requirePath(options, "blob-root"),
  }, async (host) => {
    const store = host.get("authority");
    const installation = await store.findInstallation(installationId);
    if (!installation || installation.connector_type !== "slack-channel") {
      throw new Error(`Slack installation not found: ${installationId}`);
    }
    if (installation.status !== "enabled") {
      throw new Error(`Slack installation is disabled: ${installationId}`);
    }
    const channelId = configString(installation.config, "channel_id");
    if (!channelId) {
      throw new Error("Slack installation is missing channel_id configuration");
    }
    const tokenEnv = credentialsEnvironment(installation.credentials_ref);
    const token = env[tokenEnv];
    if (!token) {
      throw new Error(`Slack access token is missing from environment variable ${tokenEnv}`);
    }
    await host.plugin(slackChannelPlugin, {
      installation_id: installation.id,
      org_id: installation.org_id,
      channel_id: channelId,
      channel_name: configString(installation.config, "channel_name"),
      access_token: token,
      endpoint: env.REGENIC_SLACK_API_ENDPOINT,
      fetch: fetchOverride,
      now,
    });
    const connector = host.get("connectors").get(
      installation.id,
      `channel:${channelId}`,
    );
    if (!connector) {
      throw new Error(`Slack connector failed to mount: ${installationId}`);
    }
    const runner = new ConnectorRunner(connector, host.get("ingest"), store, now);
    const maxPages = requirePositiveInteger(options, "max-pages", 1);
    const runs = [];
    const seenCursors = new Set<string>();
    for (let page = 0; page < maxPages; page += 1) {
      const run = await runner.poll({
        installation_id: installation.id,
        stream_key: `channel:${channelId}`,
        lease_owner: `local-cli:${createId()}`,
        lease_duration_ms: 60_000,
      });
      runs.push(run);
      if (run.status !== "completed" || !run.next_cursor) {
        break;
      }
      if (seenCursors.has(run.next_cursor)) {
        throw new Error("Slack cursor repeated before synchronization completed");
      }
      seenCursors.add(run.next_cursor);
    }
    const lastRun = runs.at(-1);
    writeJson(stdout, {
      pages_attempted: runs.length,
      stopped_at_page_limit:
        runs.length === maxPages &&
        lastRun?.status === "completed" &&
        lastRun.next_cursor !== undefined,
      runs,
    });
  });
}

async function installDsh(
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

async function syncDsh(
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

async function sendDsh(
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

async function showInbox(options: CommandOptions, stdout: CliOutput): Promise<void> {
  await withLocalHost({ database: requirePath(options, "database") }, async (host) => {
    writeJson(stdout, await host.get("authority").listInbox(requireOption(options, "org")));
  });
}

async function showStatus(options: CommandOptions, stdout: CliOutput): Promise<void> {
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

async function showQuarantines(options: CommandOptions, stdout: CliOutput): Promise<void> {
  await withLocalHost({ database: requirePath(options, "database") }, async (host) => {
    writeJson(stdout, await host.get("authority").listQuarantines(requireOption(options, "installation")));
  });
}

async function importFile(
  options: CommandOptions,
  stdout: CliOutput,
  now: () => string,
): Promise<void> {
  const database = requirePath(options, "database");
  const blobRoot = requirePath(options, "blob-root");
  const file = requirePath(options, "file");
  const mappingPath = requirePath(options, "mapping");
  const format = requireFormat(options);
  const mapping = await readImportMapping(mappingPath);
  const imported = createGenericImport({
    format,
    data: await readFile(file),
    connector_id: "generic-file-import",
    org_id: requireOption(options, "org"),
    source: requireOption(options, "source"),
    received_at: now(),
    mapping: mapping.mapping,
    defaults: mapping.defaults,
  });
  await withLocalHost({ database, blobRoot }, async (host) => {
    const batches = [];
    for (const batch of imported.batches) {
      const result = await host.get("ingest").ingest(batch);
      if (!result.valid) {
        throw new Error(`Generated import batch was rejected: ${result.error_code}`);
      }
      batches.push(result);
    }
    writeJson(stdout, {
      file_hash: imported.file_hash,
      batches,
      errors: imported.errors,
    });
  });
}

async function importWhatsAppPersonal(
  options: CommandOptions,
  stdout: CliOutput,
  now: () => string,
): Promise<void> {
  const database = requirePath(options, "database");
  const blobRoot = requirePath(options, "blob-root");
  const file = requirePath(options, "file");
  const common = {
    data: await readFile(file),
    org_id: requireOption(options, "org"),
    local_principal_id: requireOption(options, "local-principal"),
    received_at: now(),
  };
  const isPurr = file.toLowerCase().endsWith(".csv");
  const imported = isPurr
    ? createPurrWhatsAppImport({ ...common, file_name: basename(file) })
    : createWhatsAppPersonalImport(common);
  await withLocalHost({ database, blobRoot }, async (host) => {
    const authority = host.get("authority");
    const existingPurrIds = isPurr
      ? new Set(
          (
            await authority.listEvents(common.org_id, {
              source: WHATSAPP_PERSONAL_SOURCE,
            })
          ).map((event) => event.external_id),
        )
      : null;
    const batches = [];
    for (const batch of imported.batches) {
      const records = isPurr
        ? batch.records.map((record) => {
            if (
              record.operation !== "create" ||
              !existingPurrIds?.has(record.external_id)
            ) {
              existingPurrIds?.add(record.external_id);
              return record;
            }
            return {
              ...record,
              operation: "revise" as const,
              revision_id: "purr-wa-surface-v1",
            };
          })
        : batch.records;
      const result = await host.get("ingest").ingest({ ...batch, records });
      if (!result.valid) {
        throw new Error(`Generated WhatsApp batch was rejected: ${result.error_code}`);
      }
      batches.push(result);
    }
    writeJson(stdout, {
      file_hash: imported.file_hash,
      batches,
      errors: imported.errors,
    });
  });
}

async function exportJsonl(
  options: CommandOptions,
  stdout: CliOutput,
): Promise<void> {
  await withLocalHost({ database: requirePath(options, "database") }, async (host) => {
    const events = await host.get("authority").listEvents(requireOption(options, "org"));
    const output = events
      .map((event) => JSON.stringify({ schema_version: "1.0", kind: "event", event }))
      .join("\n");
    await writeFile(requirePath(options, "output"), output ? `${output}\n` : "", "utf8");
    writeJson(stdout, { exported_event_count: events.length });
  });
}

async function renderDigest(
  options: CommandOptions,
  stdout: CliOutput,
): Promise<void> {
  await withLocalHost({
    database: requirePath(options, "database"),
    blobRoot: requirePath(options, "blob-root"),
  }, async (host) => {
    const store = host.get("authority");
    const blobStore = host.get("blobs");
    const events = await store.listEvents(requireOption(options, "org"));
    const installations = await store.listInstallations(requireOption(options, "org"));
    const quarantines = (await Promise.all(
      installations.map((installation) => store.listQuarantines(installation.id)),
    )).flat();
    const entries = await Promise.all(events.map(async (event) => ({
      event,
      text: await readEventText(event.content_hash, store, blobStore),
    })));
    await writeFile(
      requirePath(options, "output"),
      renderMarkdownDigest(entries, quarantines),
      "utf8",
    );
    writeJson(stdout, {
      rendered_event_count: entries.length,
      open_quarantine_count: quarantines.length,
    });
  });
}

async function setConnectorStatus(
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

async function resetConnectorCursor(
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

async function publishEvidenceBundle(
  options: CommandOptions,
  stdout: CliOutput,
  now: () => string,
  createId: () => string,
): Promise<void> {
  await withLocalHost({ database: requirePath(options, "database") }, async (host) => {
    const events = await host.get("authority").listEvents(requireOption(options, "org"));
    const evidence = events
      .slice(-requirePositiveInteger(options, "max-events", 100))
      .map((event) => ({
        event_id: event.id,
        source: event.source,
        external_id: event.external_id,
        operation: event.operation,
        occurred_at: event.occurred_at,
        content_hash: event.content_hash,
      }));
    const bundle: EvidenceBundle = {
      schema_version: EVIDENCE_BUNDLE_SCHEMA_VERSION,
      id: createId(),
      org_id: requireOption(options, "org"),
      consumer_id: requireOption(options, "consumer"),
      purpose: requireOption(options, "purpose"),
      created_at: now(),
      evidence,
    };
    await new JsonlContextConsumer(requirePath(options, "output")).publish(bundle);
    writeJson(stdout, { bundle_id: bundle.id, published_event_count: evidence.length });
  });
}

function parseOptions(args: string[]): CommandOptions {
  const options: CommandOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) {
      throw new Error(`Unexpected argument: ${argument}`);
    }
    const name = argument.slice(2);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      options[name] = true;
      continue;
    }
    options[name] = value;
    index += 1;
  }
  return options;
}

function requireOption(options: CommandOptions, name: string): string {
  const value = optionString(options, name);
  if (!value) {
    throw new Error(`Missing required option --${name}`);
  }
  return value;
}

function requirePath(options: CommandOptions, name: string): string {
  return resolveUserPath(requireOption(options, name));
}

function optionPath(options: CommandOptions, name: string): string | undefined {
  const value = optionString(options, name);
  return value === undefined ? undefined : resolveUserPath(value);
}

function optionString(options: CommandOptions, name: string): string | undefined {
  const value = options[name];
  return typeof value === "string" ? value : undefined;
}

function resolveUserPath(pathValue: string): string {
  if (isAbsolute(pathValue)) {
    return pathValue;
  }
  const cwd = process.env.INIT_CWD && process.env.INIT_CWD.length > 0
    ? process.env.INIT_CWD
    : process.cwd();
  return resolve(cwd, pathValue);
}

function credentialsEnvironment(credentialsRef: string | undefined): string {
  try {
    return requireEnvCredentialName(credentialsRef);
  } catch {
    throw new Error("Slack installation credentials_ref must reference an environment variable");
  }
}

function configString(
  config: Record<string, JsonValue>,
  name: string,
): string | undefined {
  const value = config[name];
  return typeof value === "string" ? value : undefined;
}

function slackConfig(
  channelId: string,
  channelName: string | undefined,
): Record<string, JsonValue> {
  return channelName ? { channel_id: channelId, channel_name: channelName } : { channel_id: channelId };
}

function requireFormat(options: CommandOptions): GenericImportFormat {
  const format = requireOption(options, "format");
  if (format !== "csv" && format !== "jsonl") {
    throw new Error("--format must be csv or jsonl");
  }
  return format;
}

async function readImportMapping(path: string): Promise<{
  mapping: GenericImportMapping;
  defaults: GenericImportDefaults;
}> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`Import mapping file is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isObject(parsed) || !isObject(parsed.mapping) || !isObject(parsed.defaults)) {
    throw new Error("Import mapping file must contain mapping and defaults objects");
  }
  const mapping = parsed.mapping;
  const defaults = parsed.defaults;
  const requiredMapping = ["external_id", "occurred_at", "text"] as const;
  const requiredDefaults = ["actor_id", "scope_id", "type"] as const;
  if (
    requiredMapping.some((name) => typeof mapping[name] !== "string") ||
    requiredDefaults.some((name) => typeof defaults[name] !== "string")
  ) {
    throw new Error("Import mapping file is missing required string mapping/default fields");
  }
  return {
    mapping: {
      external_id: requireString(mapping.external_id),
      occurred_at: requireString(mapping.occurred_at),
      text: requireString(mapping.text),
      actor_id: optionalString(mapping.actor_id),
      actor_display_name: optionalString(mapping.actor_display_name),
      scope_id: optionalString(mapping.scope_id),
      scope_name: optionalString(mapping.scope_name),
      type: optionalString(mapping.type),
    },
    defaults: {
      actor_id: requireString(defaults.actor_id),
      scope_id: requireString(defaults.scope_id),
      type: requireString(defaults.type),
    },
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function requireString(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Expected a string value");
  }
  return value;
}

async function readEventText(
  contentHash: string | undefined,
  store: { findBlob(contentHash: string): Promise<{ media_type: string } | null> },
  blobStore: { get(hash: string): Promise<Uint8Array> },
): Promise<string | undefined> {
  if (!contentHash) {
    return undefined;
  }
  const blob = await store.findBlob(contentHash);
  if (!blob || blob.media_type !== "text/plain") {
    return undefined;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(await blobStore.get(contentHash));
}

function renderMarkdownDigest(entries: Array<{
  event: { id: string; source: string; external_id: string; operation: string; occurred_at: string; content_hash?: string };
  text?: string;
}>, quarantines: Array<{
  connector_installation_id: string;
  record_external_id: string;
  reason_code: string;
}>): string {
  const byDate = new Map<string, typeof entries>();
  for (const entry of entries) {
    const date = entry.event.occurred_at.slice(0, 10);
    const group = byDate.get(date) ?? [];
    group.push(entry);
    byDate.set(date, group);
  }
  const operations = entries.reduce(
    (counts, { event }) => ({ ...counts, [event.operation]: (counts[event.operation] ?? 0) + 1 }),
    {} as Record<string, number>,
  );
  const lines = [
    "# Regenic Digest",
    "",
    "## Processing Status",
    "",
    `- Events: ${entries.length}`,
    `- Creates: ${operations.create ?? 0}`,
    `- Revisions: ${operations.revise ?? 0}`,
    `- Tombstones: ${operations.tombstone ?? 0}`,
    `- Open quarantines: ${quarantines.length}`,
    "",
  ];
  if (quarantines.length > 0) {
    lines.push("## Quarantines", "");
    for (const quarantine of quarantines) {
      lines.push(
        `- **${quarantine.reason_code}** ${quarantine.record_external_id} (Installation: \`${quarantine.connector_installation_id}\`)`,
      );
    }
    lines.push("");
  }
  for (const [date, group] of byDate) {
    lines.push(`## ${date}`, "");
    for (const { event, text } of group) {
      const label = `${event.source}:${event.external_id}`;
      lines.push(`- **${event.operation}** ${label}`);
      if (text !== undefined) {
        lines.push(`  ${text.replace(/\r?\n/g, " ")}`);
      }
      const evidence = [`Event: \`${event.id}\``];
      if (event.content_hash) {
        evidence.push(`Blob: \`${event.content_hash}\``);
      }
      lines.push(`  Evidence: ${evidence.join("; ")}`, "");
    }
  }
  return `${lines.join("\n")}\n`;
}

function writeJson(stdout: CliOutput, value: unknown): void {
  stdout.write(`${JSON.stringify(value)}\n`);
}

if (require.main === module) {
  runLocalCli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

function requirePositiveInteger(
  options: CommandOptions,
  name: string,
  defaultValue: number,
): number {
  const option = optionString(options, name);
  if (option === undefined) {
    return defaultValue;
  }
  const value = Number(option);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return value;
}