import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { FsBlobStore } from "@regenic/blob-store";
import {
  ConnectorRunner,
  createGenericImport,
  type GenericImportDefaults,
  type GenericImportFormat,
  type GenericImportMapping,
  IngestionService,
  type JsonValue,
} from "@regenic/domain";
import { SqliteAuthorityStore } from "@regenic/authority-store";
import {
  SlackChannelPollConnector,
  SlackWebApiHistoryClient,
  type SlackFetch,
} from "@regenic/slack-connector";

interface CliOutput {
  write(chunk: string): boolean;
}

export interface LocalCliOptions {
  env?: NodeJS.ProcessEnv;
  stdout?: CliOutput;
  fetch?: SlackFetch;
  now?: () => string;
  createId?: () => string;
}

interface CommandOptions {
  [name: string]: string | boolean;
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
      await syncSlack(commandOptions, env, stdout, now, createId, options.fetch);
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
    case "export-jsonl":
      await exportJsonl(commandOptions, stdout);
      return;
    default:
      throw new Error("Command must be one of: slack-install, slack-sync, status, quarantines, import-file, export-jsonl");
  }
}

async function installSlack(
  options: CommandOptions,
  stdout: CliOutput,
  now: () => string,
  createId: () => string,
): Promise<void> {
  const database = requireOption(options, "database");
  const orgId = requireOption(options, "org");
  const channelId = requireOption(options, "channel");
  const tokenEnv = optionString(options, "token-env") ?? "REGENIC_SLACK_TOKEN";
  const store = new SqliteAuthorityStore(database);
  try {
    const installation = await store.createInstallation({
      id: optionString(options, "id") ?? createId(),
      org_id: orgId,
      connector_type: "slack-channel",
      status: "enabled",
      config: slackConfig(channelId, optionString(options, "channel-name")),
      credentials_ref: `env:${tokenEnv}`,
      created_at: now(),
    });
    writeJson(stdout, installation);
  } finally {
    store.close();
  }
}

async function syncSlack(
  options: CommandOptions,
  env: NodeJS.ProcessEnv,
  stdout: CliOutput,
  now: () => string,
  createId: () => string,
  fetchOverride?: SlackFetch,
): Promise<void> {
  const database = requireOption(options, "database");
  const blobRoot = requireOption(options, "blob-root");
  const installationId = requireOption(options, "installation");
  const store = new SqliteAuthorityStore(database);
  try {
    const installation = await store.findInstallation(installationId);
    if (!installation || installation.connector_type !== "slack-channel") {
      throw new Error(`Slack installation not found: ${installationId}`);
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
    const client = new SlackWebApiHistoryClient({
      access_token: token,
      endpoint: env.REGENIC_SLACK_API_ENDPOINT,
      fetch: fetchOverride,
    });
    const connector = new SlackChannelPollConnector(client, {
      connector_id: installation.id,
      org_id: installation.org_id,
      channel_id: channelId,
      channel_name: configString(installation.config, "channel_name"),
      now,
    });
    const runner = new ConnectorRunner(
      connector,
      new IngestionService(new FsBlobStore(blobRoot), store),
      store,
      now,
    );
    const run = await runner.poll({
      installation_id: installation.id,
      stream_key: `channel:${channelId}`,
      lease_owner: `local-cli:${createId()}`,
      lease_duration_ms: 60_000,
    });
    writeJson(stdout, run);
  } finally {
    store.close();
  }
}

async function showStatus(options: CommandOptions, stdout: CliOutput): Promise<void> {
  const store = new SqliteAuthorityStore(requireOption(options, "database"));
  try {
    const installations = await store.listInstallations(requireOption(options, "org"));
    const status = await Promise.all(
      installations.map(async (installation) => ({
        installation,
        attempts: await store.listAttempts(installation.id),
      })),
    );
    writeJson(stdout, status);
  } finally {
    store.close();
  }
}

async function showQuarantines(options: CommandOptions, stdout: CliOutput): Promise<void> {
  const store = new SqliteAuthorityStore(requireOption(options, "database"));
  try {
    writeJson(stdout, await store.listQuarantines(requireOption(options, "installation")));
  } finally {
    store.close();
  }
}

async function importFile(
  options: CommandOptions,
  stdout: CliOutput,
  now: () => string,
): Promise<void> {
  const database = requireOption(options, "database");
  const blobRoot = requireOption(options, "blob-root");
  const file = requireOption(options, "file");
  const mappingPath = requireOption(options, "mapping");
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
  const store = new SqliteAuthorityStore(database);
  try {
    const service = new IngestionService(new FsBlobStore(blobRoot), store);
    const batches = [];
    for (const batch of imported.batches) {
      const result = await service.ingest(batch);
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
  } finally {
    store.close();
  }
}

async function exportJsonl(
  options: CommandOptions,
  stdout: CliOutput,
): Promise<void> {
  const store = new SqliteAuthorityStore(requireOption(options, "database"));
  try {
    const events = await store.listEvents(requireOption(options, "org"));
    const output = events
      .map((event) => JSON.stringify({ schema_version: "1.0", kind: "event", event }))
      .join("\n");
    await writeFile(requireOption(options, "output"), output ? `${output}\n` : "", "utf8");
    writeJson(stdout, { exported_event_count: events.length });
  } finally {
    store.close();
  }
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

function optionString(options: CommandOptions, name: string): string | undefined {
  const value = options[name];
  return typeof value === "string" ? value : undefined;
}

function credentialsEnvironment(credentialsRef: string | undefined): string {
  if (!credentialsRef?.startsWith("env:")) {
    throw new Error("Slack installation credentials_ref must reference an environment variable");
  }
  return credentialsRef.slice("env:".length);
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

function writeJson(stdout: CliOutput, value: unknown): void {
  stdout.write(`${JSON.stringify(value)}\n`);
}

if (require.main === module) {
  runLocalCli(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}