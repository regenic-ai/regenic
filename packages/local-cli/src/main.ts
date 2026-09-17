import { randomUUID } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { INGEST_ATTEMPT_KEEP_PER_INSTALLATION } from "@regenic/authority-store";
import {
  ContextQuestionAnswerer,
  evaluateContextRetrieval,
  type ContextEvaluationDataset,
} from "@regenic/context-engine";
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
  type ContextRequest,
  projectEvidenceBundleV1,
  PROPOSAL_SCHEMA_VERSION,
  DECISION_SCHEMA_VERSION,
  REVIEW_SCHEMA_VERSION,
  HANDOFF_SCHEMA_VERSION,
  STANDARD_SCHEMA_VERSION,
  STANDARD_VERSION_SCHEMA_VERSION,
  hashCanonicalContext,
  hashStandardVersionBody,
  validateIterationGate,
  validateStandardScope,
  validateTrialConfig,
  validateUpgradeEvidence,
  type ProposalKind,
  type ProposalRecord,
  type DecisionRecord,
  type ReviewRecord,
  type HandoffDirection,
  type HandoffReason,
  type HandoffRecord,
  type HandoffStatus,
  type IterationGate,
  type StandardLayer,
  type StandardRecord,
  type StandardScope,
  type StandardVersionRecord,
  type StandardVersionStatus,
  type TrialConfig,
  type UpgradeEvidence,
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
import { modelProviderConfigFromEnv } from "@regenic/model-provider";
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
    case "context-assemble":
      await assembleContext(commandOptions, stdout, createId);
      return;
    case "context-snapshot":
      await showContextSnapshot(commandOptions, stdout);
      return;
    case "context-replay":
      await replayContext(commandOptions, stdout);
      return;
    case "context-publish-evidence-bundle":
      await publishContextEvidenceBundle(commandOptions, stdout, now);
      return;
    case "context-ask":
      await askContext(commandOptions, env, stdout, createId);
      return;
    case "context-evaluate":
      await evaluateContext(commandOptions, stdout);
      return;
    case "context-daily-digest-project":
      await projectDailyDigest(commandOptions, stdout);
      return;
    case "context-daily-digest-get":
      await getDailyDigests(commandOptions, stdout);
      return;
    case "context-daily-digest-jobs":
      await getDailyDigestJobs(commandOptions, stdout);
      return;
    case "context-daily-digest-alerts":
      await getDailyDigestCoverageAlerts(commandOptions, stdout);
      return;
    case "context-daily-digest-alert-resolve":
      await resolveDailyDigestCoverageAlert(commandOptions, stdout, now);
      return;
    case "context-proposal-create":
      await createProposalFromDigest(commandOptions, stdout, now);
      return;
    case "context-proposals":
      await listProposals(commandOptions, stdout);
      return;
    case "context-proposal-get":
      await getProposal(commandOptions, stdout);
      return;
    case "context-proposal-submit":
      await transitionProposal(commandOptions, stdout, now, "submitted");
      return;
    case "context-proposal-new-decision":
      await createDecisionProposal(commandOptions, stdout, now);
      return;
    case "context-proposal-review":
      await transitionProposal(commandOptions, stdout, now, "in_review");
      return;
    case "context-proposal-reject":
      await transitionProposal(commandOptions, stdout, now, "rejected");
      return;
    case "context-proposal-withdraw":
      await transitionProposal(commandOptions, stdout, now, "withdrawn");
      return;
    case "context-decision-commit":
      await commitDecision(commandOptions, stdout, now);
      return;
    case "context-decisions":
      await listDecisions(commandOptions, stdout);
      return;
    case "context-decision-get":
      await getDecision(commandOptions, stdout);
      return;
    case "context-review-new-decision":
      await createDecisionReview(commandOptions, stdout, now);
      return;
    case "context-decision-reviews":
      await listDecisionReviews(commandOptions, stdout);
      return;
    case "context-review-get":
      await getReview(commandOptions, stdout);
      return;
    case "context-handoff-create":
      await createHandoff(commandOptions, stdout, now);
      return;
    case "context-handoffs":
      await listHandoffs(commandOptions, stdout);
      return;
    case "context-handoff-get":
      await getHandoff(commandOptions, stdout);
      return;
    case "context-handoff-ack":
      await transitionHandoff(commandOptions, stdout, now, "acked");
      return;
    case "context-handoff-resolve":
      await transitionHandoff(commandOptions, stdout, now, "resolved");
      return;
    case "context-handoff-cancel":
      await transitionHandoff(commandOptions, stdout, now, "cancelled");
      return;
    case "context-proposal-new-standard":
      await createStandardProposal(commandOptions, stdout, now, "new_standard");
      return;
    case "context-proposal-revise-standard":
      await createStandardProposal(commandOptions, stdout, now, "revise_standard");
      return;
    case "context-standard-version-commit":
      await commitStandardVersion(commandOptions, stdout, now);
      return;
    case "context-standards":
      await listStandards(commandOptions, stdout);
      return;
    case "context-standard-get":
      await getStandard(commandOptions, stdout);
      return;
    case "context-standard-versions":
      await listStandardVersions(commandOptions, stdout);
      return;
    case "context-standard-version-get":
      await getStandardVersion(commandOptions, stdout);
      return;
    case "context-standard-version-publish-trial":
      await transitionCliStandardVersion(commandOptions, stdout, now, "trial");
      return;
    case "context-standard-version-publish-active":
    case "context-standard-version-promote":
      await transitionCliStandardVersion(commandOptions, stdout, now, "active");
      return;
    case "context-standard-version-deprecate":
      await transitionCliStandardVersion(commandOptions, stdout, now, "deprecated");
      return;
    default:
      throw new Error("Command must be one of: slack-install, slack-sync, dsh-install, dsh-sync, dsh-send, status, quarantines, import-file, whatsapp-import, export-jsonl, render-digest, connector-enable, connector-disable, reset-cursor, publish-evidence-bundle, inbox, context-assemble, context-snapshot, context-replay, context-publish-evidence-bundle, context-ask, context-evaluate, context-daily-digest-project, context-daily-digest-get, context-daily-digest-jobs, context-daily-digest-alerts, context-daily-digest-alert-resolve, context-proposal-create, context-proposal-new-decision, context-proposal-new-standard, context-proposal-revise-standard, context-proposals, context-proposal-get, context-proposal-submit, context-proposal-review, context-proposal-reject, context-proposal-withdraw, context-decision-commit, context-decisions, context-decision-get, context-review-new-decision, context-decision-reviews, context-review-get, context-handoff-create, context-handoffs, context-handoff-get, context-handoff-ack, context-handoff-resolve, context-handoff-cancel, context-standard-version-commit, context-standards, context-standard-get, context-standard-versions, context-standard-version-get, context-standard-version-publish-trial, context-standard-version-publish-active, context-standard-version-promote, context-standard-version-deprecate");
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

async function assembleContext(
  options: CommandOptions,
  stdout: CliOutput,
  createId: () => string,
): Promise<void> {
  const orgId = requireOption(options, "org");
  await withLocalHost({
    database: requirePath(options, "database"),
    blobRoot: requirePath(options, "blob-root"),
    orgId,
    model: { driver: "none" },
  }, async (host) => {
    await bootstrapLocalContextSearch(host, orgId);
    writeJson(stdout, await host.get("context").assemble(
      localContextRequest(options, orgId, createId),
    ));
  });
}

async function showContextSnapshot(
  options: CommandOptions,
  stdout: CliOutput,
): Promise<void> {
  const orgId = requireOption(options, "org");
  const snapshotId = requireOption(options, "snapshot");
  await withLocalHost({
    database: requirePath(options, "database"),
    blobRoot: requirePath(options, "blob-root"),
    orgId,
    model: { driver: "none" },
  }, async (host) => {
    const snapshot = await host.get("context-artifacts").getSnapshot(orgId, snapshotId);
    if (!snapshot) {
      throw new Error(`Context snapshot not found: ${snapshotId}`);
    }
    writeJson(stdout, snapshot);
  });
}

async function replayContext(
  options: CommandOptions,
  stdout: CliOutput,
): Promise<void> {
  const orgId = requireOption(options, "org");
  await withLocalHost({
    database: requirePath(options, "database"),
    blobRoot: requirePath(options, "blob-root"),
    orgId,
    model: { driver: "none" },
  }, async (host) => {
    writeJson(stdout, await host.get("context").replay({
      org_id: orgId,
      snapshot_id: requireOption(options, "snapshot"),
      principal: { actor_type: "human", actor_id: orgId },
      consumer_id: optionString(options, "consumer") ?? "local-cli",
      purpose: optionString(options, "purpose") ?? "inspect authorized local context",
      allowed_uses: ["display"],
    }));
  });
}

async function publishContextEvidenceBundle(
  options: CommandOptions,
  stdout: CliOutput,
  now: () => string,
): Promise<void> {
  const orgId = requireOption(options, "org");
  await withLocalHost({
    database: requirePath(options, "database"),
    blobRoot: requirePath(options, "blob-root"),
    orgId,
    model: { driver: "none" },
  }, async (host) => {
    const bundle = await host.get("context").replay({
      org_id: orgId,
      snapshot_id: requireOption(options, "snapshot"),
      principal: { actor_type: "human", actor_id: orgId },
      consumer_id: requireOption(options, "consumer"),
      purpose: requireOption(options, "purpose"),
      allowed_uses: ["display"],
    });
    const projected = projectEvidenceBundleV1(bundle, now());
    await new JsonlContextConsumer(requirePath(options, "output")).publish(projected);
    writeJson(stdout, {
      bundle_id: projected.id,
      snapshot_id: bundle.snapshot_id,
      published_event_count: projected.evidence.length,
    });
  });
}

async function askContext(
  options: CommandOptions,
  env: NodeJS.ProcessEnv,
  stdout: CliOutput,
  createId: () => string,
): Promise<void> {
  const orgId = requireOption(options, "org");
  const question = requireOption(options, "question");
  await withLocalHost({
    database: requirePath(options, "database"),
    blobRoot: requirePath(options, "blob-root"),
    orgId,
    model: modelProviderConfigFromEnv(env),
  }, async (host) => {
    await bootstrapLocalContextSearch(host, orgId);
    const request = localContextRequest(
      options,
      orgId,
      createId,
      question,
      "local-cli-context-ask",
      "answer an authorized local context question",
    );
    writeJson(stdout, await new ContextQuestionAnswerer(
      host.get("context"),
      host.get("model"),
    ).ask(request, question));
  });
}

async function evaluateContext(
  options: CommandOptions,
  stdout: CliOutput,
): Promise<void> {
  const orgId = requireOption(options, "org");
  const dataset = JSON.parse(
    await readFile(requirePath(options, "dataset"), "utf8"),
  ) as ContextEvaluationDataset;
  assertPersonalEvaluationDataset(dataset, orgId);
  await withLocalHost({
    database: requirePath(options, "database"),
    blobRoot: requirePath(options, "blob-root"),
    orgId,
    model: { driver: "none" },
  }, async (host) => {
    await bootstrapLocalContextSearch(host, orgId);
    const report = await evaluateContextRetrieval(host.get("context"), dataset, {
      k: requirePositiveInteger(options, "k", 10),
    });
    const output = optionString(options, "output");
    if (output) {
      await writeFile(resolve(output), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    }
    writeJson(stdout, report);
  });
}

async function bootstrapLocalContextSearch(
  host: import("@regenic/plugin-host").Host,
  orgId: string,
): Promise<void> {
  await host.get("context-projections").syncLexicalIndex(orgId, "continuous-v1");
}

function assertPersonalEvaluationDataset(
  dataset: ContextEvaluationDataset,
  orgId: string,
): void {
  if (
    !dataset ||
    !Array.isArray(dataset.cases) ||
    dataset.cases.some(({ request }) =>
      request?.org_id !== orgId ||
      request?.principal?.actor_type !== "human" ||
      request?.principal?.actor_id !== orgId,
    )
  ) {
    throw new Error("Context evaluation dataset exceeds the local Personal authority boundary");
  }
}

function localContextRequest(
  options: CommandOptions,
  orgId: string,
  createId: () => string,
  query = optionString(options, "query"),
  defaultConsumer = "local-cli",
  defaultPurpose = "inspect authorized local context",
): ContextRequest {
  const thread = optionString(options, "thread");
  const source = optionString(options, "source");
  return {
    schema_version: "1.0",
    id: createId(),
    org_id: orgId,
    principal: { actor_type: "human", actor_id: orgId },
    consumer_id: optionString(options, "consumer") ?? defaultConsumer,
    purpose: optionString(options, "purpose") ?? defaultPurpose,
    allowed_uses: ["display", "reason"],
    ...(query ? { query } : {}),
    ...(thread ? { anchors: [{ kind: "conversation", id: thread }] } : {}),
    ...(source ? { filters: { sources: [source] } } : {}),
    temporal: { mode: "current" },
    budget: {
      profile: "local-cli-v1",
      max_tokens: requirePositiveInteger(options, "max-tokens", 4_000),
      max_items: requirePositiveInteger(options, "max-items", 20),
      max_raw_evidence: requirePositiveInteger(options, "max-evidence", 20),
    },
    requested_kinds: ["event"],
  };
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

async function projectDailyDigest(options: CommandOptions, stdout: CliOutput): Promise<void> {
  const orgId = requireOption(options, "org");
  await withLocalHost({
    database: requirePath(options, "database"),
    blobRoot: requirePath(options, "blob-root"),
    orgId,
    model: { driver: "none" },
  }, async (host) => {
    writeJson(stdout, await host.get("context-daily-digests").projectDailyDigest({
      org_id: orgId,
      utc_date: requireUtcDate(options),
    }));
  });
}

async function getDailyDigests(options: CommandOptions, stdout: CliOutput): Promise<void> {
  const orgId = requireOption(options, "org");
  const date = requireUtcDate(options);
  await withLocalHost({
    database: requirePath(options, "database"),
    blobRoot: requirePath(options, "blob-root"),
    orgId,
    model: { driver: "none" },
  }, async (host) => {
    const values = await host.get("context-artifacts").listArtifacts({
      org_id: orgId,
      kinds: ["daily_digest"],
      statuses: ["accepted"],
    });
    writeJson(stdout, values.filter((artifact) =>
      artifact.attrs && typeof artifact.attrs === "object" && !Array.isArray(artifact.attrs) &&
      artifact.attrs.utc_date === date,
    ));
  });
}

async function getDailyDigestJobs(options: CommandOptions, stdout: CliOutput): Promise<void> {
  const orgId = requireOption(options, "org");
  await withLocalHost({
    database: requirePath(options, "database"),
    blobRoot: requirePath(options, "blob-root"),
    orgId,
    model: { driver: "none" },
  }, async (host) => {
    const jobs = await host.get("daily-digest-jobs").listDailyDigestJobs(orgId);
    writeJson(stdout, jobs.map(({ lease_owner, last_error, ...job }) => job));
  });
}

function requireUtcDate(options: CommandOptions): string {
  const date = requireOption(options, "utc-date");
  const timestamp = Date.parse(`${date}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== date) {
    throw new Error("--utc-date must be YYYY-MM-DD in UTC");
  }
  return date;
}

async function getDailyDigestCoverageAlerts(options: CommandOptions, stdout: CliOutput): Promise<void> {
  const orgId = requireOption(options, "org");
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => {
    const alerts = await host.get("daily-digest-coverage-alerts").listDailyDigestCoverageAlerts({ org_id: orgId, status: "open", limit: 100 });
    writeJson(stdout, alerts.map(({ event_id, org_id, ...alert }) => alert));
  });
}

async function resolveDailyDigestCoverageAlert(options: CommandOptions, stdout: CliOutput, now: () => string): Promise<void> {
  const orgId = requireOption(options, "org");
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => {
    const value = await host.get("daily-digest-coverage-alerts").resolveDailyDigestCoverageAlert({ org_id: orgId, alert_id: requireOption(options, "alert"), resolved_at: now() });
    if (!value) throw new Error("Coverage alert was not found");
    const { event_id, org_id, ...alert } = value;
    writeJson(stdout, alert);
  });
}

async function createProposalFromDigest(options: CommandOptions, stdout: CliOutput, now: () => string): Promise<void> {
  const orgId = requireOption(options, "org");
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => {
    const artifactId = requireOption(options, "digest");
    const eventId = requireOption(options, "event");
    const direction = requireOption(options, "direction");
    const artifacts = host.get("context-artifacts");
    const artifact = await artifacts.getArtifact(orgId, artifactId);
    const state = artifact ? await artifacts.getArtifactState(orgId, artifact.id) : null;
    if (!artifact || artifact.kind !== "daily_digest" || state?.status !== "accepted" || !artifact.body_hash || hashCanonicalContext(artifact.attrs) !== artifact.body_hash) throw new Error("Proposal intake requires an accepted valid daily digest");
    const item = cliDigestItem(artifact.attrs, direction, eventId);
    const kind = cliProposalKind(item.item_kind);
    const head = artifact.input_refs.find((reference) => reference.event_id === eventId);
    if (!head) throw new Error("Digest item is not bound to artifact evidence");
    const evidence = artifact.input_refs.filter((reference) => reference.source === head.source && reference.external_id === head.external_id).map((reference) => ({ kind: "document" as const, uri_or_ref: `event:${reference.event_id}` }));
    evidence.unshift({ kind: "document", uri_or_ref: `artifact:${artifact.id}` });
    const at = now();
    const summary = requireString(item.text);
    const proposal: ProposalRecord = {
      schema_version: PROPOSAL_SCHEMA_VERSION,
      id: `proposal:${hashCanonicalContext([orgId, artifact.id, direction, eventId])}`,
      org_id: orgId, kind, title: summary.split(/\r?\n/, 1)[0].slice(0, 120), summary,
      status: "draft", author: { actor_type: "human", actor_id: orgId }, rights_level: "coach",
      boundary: optionalString(options.boundary) ?? `${direction} daily digest item`,
      standard_bindings: [],
      ...(optionalString(options.uncertainty) ? { single_uncertainty: optionalString(options.uncertainty)! } : {}),
      evidence, source_digest_id: artifact.id, source_item_event_id: eventId,
      created_at: at, updated_at: at,
    };
    writeJson(stdout, await host.get("proposals").putProposal(proposal));
  });
}

async function listProposals(options: CommandOptions, stdout: CliOutput): Promise<void> {
  const orgId = requireOption(options, "org");
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => writeJson(stdout, await host.get("proposals").listProposals({ org_id: orgId, limit: 100 })));
}

async function getProposal(options: CommandOptions, stdout: CliOutput): Promise<void> {
  const orgId = requireOption(options, "org");
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => {
    const proposal = await host.get("proposals").getProposal(orgId, requireOption(options, "proposal"));
    if (!proposal) throw new Error("Proposal was not found");
    writeJson(stdout, proposal);
  });
}

async function createDecisionProposal(options: CommandOptions, stdout: CliOutput, now: () => string): Promise<void> {
  const orgId = requireOption(options, "org");
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => {
    const snapshotId = requireOption(options, "snapshot");
    if (!await host.get("context-artifacts").getSnapshot(orgId, snapshotId)) throw new Error("Context snapshot was not found");
    const at = now();
    const rights = optionString(options, "rights") ?? "coach";
    if (!["direct", "coach", "negotiate", "authorize", "delegate"].includes(rights)) throw new Error("Invalid rights level");
    const proposal: ProposalRecord = {
      schema_version: PROPOSAL_SCHEMA_VERSION,
      id: `proposal:${hashCanonicalContext([orgId, requireOption(options, "request")])}`,
      org_id: orgId, kind: "decision", title: requireOption(options, "title"),
      summary: requireOption(options, "summary"), status: "draft",
      author: { actor_type: "human", actor_id: orgId }, rights_level: rights as ProposalRecord["rights_level"],
      boundary: requireOption(options, "boundary"), context_snapshot_id: snapshotId,
      standard_bindings: [], evidence: [{ kind: "document", uri_or_ref: `event:${requireOption(options, "event")}` }],
      created_at: at, updated_at: at,
    };
    writeJson(stdout, await host.get("proposals").putProposal(proposal));
  });
}

async function transitionProposal(options: CommandOptions, stdout: CliOutput, now: () => string, status: "submitted" | "in_review" | "rejected" | "withdrawn"): Promise<void> {
  const orgId = requireOption(options, "org");
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => {
    const proposal = await host.get("proposals").transitionProposal({ org_id: orgId, proposal_id: requireOption(options, "proposal"), status, updated_at: now() });
    if (!proposal) throw new Error("Proposal was not found");
    writeJson(stdout, proposal);
  });
}

async function commitDecision(options: CommandOptions, stdout: CliOutput, now: () => string): Promise<void> {
  const orgId = requireOption(options, "org");
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => {
    const proposalId = requireOption(options, "proposal");
    const proposal = await host.get("proposals").getProposal(orgId, proposalId);
    if (!proposal || proposal.kind !== "decision" || proposal.status !== "in_review" || !proposal.context_snapshot_id) throw new Error("Decision commit requires an in-review decision Proposal");
    const coDeciders = (optionString(options, "co-deciders") ?? "").split(",").map((value) => value.trim()).filter(Boolean).map((actorId) => ({ actor_type: "human" as const, actor_id: actorId }));
    const decision: DecisionRecord = {
      schema_version: DECISION_SCHEMA_VERSION,
      id: `decision:${hashCanonicalContext([orgId, proposal.id])}`,
      org_id: orgId, proposal_id: proposal.id, summary: requireOption(options, "summary"),
      rationale: requireOption(options, "rationale"), decided_by: { actor_type: "human", actor_id: orgId },
      co_deciders: coDeciders, rights_level: proposal.rights_level,
      context_snapshot_id: proposal.context_snapshot_id, standard_bindings: proposal.standard_bindings,
      status: "committed", committed_at: now(),
    };
    writeJson(stdout, await host.get("decisions").commitProposalDecision({ org_id: orgId, proposal_id: proposal.id, decision }));
  });
}

async function listDecisions(options: CommandOptions, stdout: CliOutput): Promise<void> {
  const orgId = requireOption(options, "org");
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => writeJson(stdout, await host.get("decisions").listDecisions({ org_id: orgId, limit: 100 })));
}

async function getDecision(options: CommandOptions, stdout: CliOutput): Promise<void> {
  const orgId = requireOption(options, "org");
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => {
    const decision = await host.get("decisions").getDecision(orgId, requireOption(options, "decision"));
    if (!decision) throw new Error("Decision was not found");
    writeJson(stdout, decision);
  });
}

async function createDecisionReview(options: CommandOptions, stdout: CliOutput, now: () => string): Promise<void> {
  const orgId = requireOption(options, "org");
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => {
    const decisionId = requireOption(options, "decision");
    const decision = await host.get("decisions").getDecision(orgId, decisionId);
    if (!decision) throw new Error("Decision was not found");
    const eventId = requireOption(options, "event");
    if (!await host.get("authority").getEvent(orgId, eventId)) throw new Error("Review evidence Event was not found");
    const result = requireOption(options, "result");
    if (!["validated", "falsified", "inconclusive"].includes(result)) throw new Error("Invalid Review result");
    const severity = optionString(options, "severity") ?? "normal";
    if (!["normal", "bad_news"].includes(severity)) throw new Error("Invalid Review severity");
    const action = optionString(options, "action") ?? "none";
    if (!["solidify", "revise_standard", "open_gap", "none"].includes(action)) throw new Error("Invalid Review action");
    const evidenceKind = optionString(options, "evidence-kind") ?? "document";
    if (!["data", "demo", "user_quote", "document", "other"].includes(evidenceKind)) throw new Error("Invalid Review evidence kind");
    const reviews = host.get("reviews");
    const id = `review:${hashCanonicalContext([orgId, decision.id, requireOption(options, "request")])}`;
    const existing = await reviews.getReview(orgId, id);
    const review: ReviewRecord = {
      schema_version: REVIEW_SCHEMA_VERSION,
      id,
      org_id: orgId,
      subject_kind: "decision",
      subject_id: decision.id,
      result: result as ReviewRecord["result"],
      severity: severity as ReviewRecord["severity"],
      evidence: [{ kind: evidenceKind as ReviewRecord["evidence"][number]["kind"], uri_or_ref: `event:${eventId}` }],
      context_snapshot_id: decision.context_snapshot_id,
      recommended_action: action as ReviewRecord["recommended_action"],
      author: { actor_type: "human", actor_id: orgId },
      created_at: existing?.created_at ?? now(),
    };
    writeJson(stdout, await reviews.putReview(review));
  });
}

async function listDecisionReviews(options: CommandOptions, stdout: CliOutput): Promise<void> {
  const orgId = requireOption(options, "org");
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => {
    const decisionId = requireOption(options, "decision");
    if (!await host.get("decisions").getDecision(orgId, decisionId)) throw new Error("Decision was not found");
    writeJson(stdout, await host.get("reviews").listReviews({ org_id: orgId, subject_id: decisionId, limit: 100 }));
  });
}

async function getReview(options: CommandOptions, stdout: CliOutput): Promise<void> {
  const orgId = requireOption(options, "org");
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => {
    const review = await host.get("reviews").getReview(orgId, requireOption(options, "review"));
    if (!review) throw new Error("Review was not found");
    writeJson(stdout, review);
  });
}

async function createHandoff(options: CommandOptions, stdout: CliOutput, now: () => string): Promise<void> {
  const orgId = requireOption(options, "org");
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => {
    const snapshotId = requireOption(options, "snapshot");
    if (!await host.get("context-artifacts").getSnapshot(orgId, snapshotId)) throw new Error("Context snapshot was not found");
    const proposalId = optionString(options, "proposal");
    const proposal = proposalId ? await host.get("proposals").getProposal(orgId, proposalId) : null;
    if (proposalId && !proposal) throw new Error("Proposal was not found");
    const decisionId = optionString(options, "decision");
    const decision = decisionId ? await host.get("decisions").getDecision(orgId, decisionId) : null;
    if (decisionId && !decision) throw new Error("Decision was not found");
    if (proposal && decision && decision.proposal_id !== proposal.id) throw new Error("Handoff Proposal and Decision do not refer to the same outcome");
    const direction = cliHandoffDirection(requireOption(options, "direction"));
    const agentId = requireOption(options, "agent");
    const human = { actor_type: "human" as const, actor_id: orgId };
    const agent = { actor_type: "agent" as const, actor_id: agentId };
    const handoffs = host.get("handoffs");
    const id = `handoff:${hashCanonicalContext([orgId, requireOption(options, "request")])}`;
    const existing = await handoffs.getHandoff(orgId, id);
    const handoff: HandoffRecord = {
      schema_version: HANDOFF_SCHEMA_VERSION,
      id,
      org_id: orgId,
      direction,
      from: direction === "human_to_agent" ? human : agent,
      to: direction === "human_to_agent" ? agent : human,
      reason: cliHandoffReason(requireOption(options, "reason")),
      ...(proposalId ? { proposal_id: proposalId } : {}),
      ...(decisionId ? { decision_id: decisionId } : {}),
      context_snapshot_id: snapshotId,
      standard_bindings: cliStandardBindings(optionString(options, "bindings")),
      payload: cliHandoffPayload(requireOption(options, "payload")),
      status: "open",
      created_at: existing?.created_at ?? now(),
    };
    writeJson(stdout, await handoffs.putHandoff(handoff));
  });
}

async function listHandoffs(options: CommandOptions, stdout: CliOutput): Promise<void> {
  const orgId = requireOption(options, "org");
  const status = optionString(options, "status");
  const direction = optionString(options, "direction");
  if (status && !["open", "acked", "resolved", "cancelled"].includes(status)) throw new Error("Invalid Handoff status");
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => {
    writeJson(stdout, await host.get("handoffs").listHandoffs({
      org_id: orgId,
      ...(status ? { status: status as HandoffStatus } : {}),
      ...(direction ? { direction: cliHandoffDirection(direction) } : {}),
      limit: 100,
    }));
  });
}

async function getHandoff(options: CommandOptions, stdout: CliOutput): Promise<void> {
  const orgId = requireOption(options, "org");
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => {
    const handoff = await host.get("handoffs").getHandoff(orgId, requireOption(options, "handoff"));
    if (!handoff) throw new Error("Handoff was not found");
    writeJson(stdout, handoff);
  });
}

async function transitionHandoff(options: CommandOptions, stdout: CliOutput, now: () => string, status: Exclude<HandoffStatus, "open">): Promise<void> {
  const orgId = requireOption(options, "org");
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => {
    const handoff = await host.get("handoffs").transitionHandoff({
      org_id: orgId, handoff_id: requireOption(options, "handoff"), status, transitioned_at: now(),
    });
    if (!handoff) throw new Error("Handoff was not found");
    writeJson(stdout, handoff);
  });
}

function cliHandoffDirection(value: string): HandoffDirection {
  if (!["agent_to_human", "human_to_agent"].includes(value)) throw new Error("Invalid Handoff direction");
  return value as HandoffDirection;
}

function cliHandoffReason(value: string): HandoffReason {
  if (![
    "standard_uncovered", "evidence_conflict", "permission_denied", "acceptance_failed",
    "escalation_boundary", "approve_proposal", "revise_standard", "enrich_context",
    "set_boundary", "retry_with_binding",
  ].includes(value)) throw new Error("Invalid Handoff reason");
  return value as HandoffReason;
}

function cliHandoffPayload(value: string): Record<string, JsonValue> {
  let payload: unknown;
  try { payload = JSON.parse(value); } catch { throw new Error("Handoff payload must be valid JSON"); }
  if (!isObject(payload) || Object.keys(payload).length === 0) throw new Error("Handoff payload must be a non-empty object");
  return payload as Record<string, JsonValue>;
}

function cliStandardBindings(value: string | undefined): HandoffRecord["standard_bindings"] {
  if (!value) return [];
  return value.split(",").map((entry) => {
    const separator = entry.lastIndexOf("@");
    if (separator < 1 || separator === entry.length - 1) throw new Error("Handoff bindings must use standard@version");
    return { standard_id: entry.slice(0, separator), version_id: entry.slice(separator + 1) };
  });
}

async function createStandardProposal(
  options: CommandOptions,
  stdout: CliOutput,
  now: () => string,
  kind: "new_standard" | "revise_standard",
): Promise<void> {
  const orgId = requireOption(options, "org");
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => {
    const snapshotId = requireOption(options, "snapshot");
    if (!await host.get("context-artifacts").getSnapshot(orgId, snapshotId)) throw new Error("Context snapshot was not found");
    const eventId = requireOption(options, "event");
    if (!await host.get("authority").getEvent(orgId, eventId)) throw new Error("Proposal evidence Event was not found");
    const rights = optionString(options, "rights") ?? "coach";
    if (!["direct", "coach", "negotiate", "authorize", "delegate"].includes(rights)) throw new Error("Invalid rights level");
    let standardBindings: ProposalRecord["standard_bindings"] = [];
    if (kind === "revise_standard") {
      const standardId = requireOption(options, "standard");
      const supersedesId = requireOption(options, "supersedes");
      const standard = await host.get("standards").getStandard(orgId, standardId);
      const superseded = await host.get("standards").getStandardVersion(orgId, supersedesId);
      if (!standard || !superseded || superseded.standard_id !== standard.id || superseded.status === "draft") {
        throw new Error("Revision must pin a published StandardVersion");
      }
      standardBindings = [{ standard_id: standard.id, version_id: superseded.id }];
    }
    const at = now();
    const proposal: ProposalRecord = {
      schema_version: PROPOSAL_SCHEMA_VERSION,
      id: `proposal:${hashCanonicalContext([orgId, requireOption(options, "request")])}`,
      org_id: orgId,
      kind,
      title: requireOption(options, "title"),
      summary: requireOption(options, "summary"),
      status: "draft",
      author: { actor_type: "human", actor_id: orgId },
      rights_level: rights as ProposalRecord["rights_level"],
      boundary: requireOption(options, "boundary"),
      context_snapshot_id: snapshotId,
      standard_bindings: standardBindings,
      single_uncertainty: requireOption(options, "uncertainty"),
      evidence: [{ kind: "document", uri_or_ref: `event:${eventId}` }],
      created_at: at,
      updated_at: at,
    };
    writeJson(stdout, await host.get("proposals").putProposal(proposal));
  });
}

async function commitStandardVersion(options: CommandOptions, stdout: CliOutput, now: () => string): Promise<void> {
  const orgId = requireOption(options, "org");
  const spec = await readJsonObject(requirePath(options, "spec"), "StandardVersion spec");
  assertObjectKeys(spec, new Set([
    "slug", "title", "layer", "scope", "target_standard_id", "supersedes_version_id",
    "version", "condition", "action", "acceptance", "boundary", "revision_trigger",
    "gate", "trial",
  ]), "StandardVersion spec");
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => {
    const proposalId = requireOption(options, "proposal");
    const proposal = await host.get("proposals").getProposal(orgId, proposalId);
    if (!proposal || !["new_standard", "revise_standard"].includes(proposal.kind)
      || !["in_review", "accepted"].includes(proposal.status) || !proposal.single_uncertainty) {
      throw new Error("StandardVersion commit requires an in-review Standard Proposal");
    }
    const gate = validateIterationGate(spec.gate as IterationGate);
    if (gate.single_uncertainty !== proposal.single_uncertainty) throw new Error("IterationGate must preserve the Proposal uncertainty");
    const at = now();
    let standard: StandardRecord | undefined;
    let standardId: string;
    let supersedesVersionId: string | undefined;
    if (proposal.kind === "new_standard") {
      if (spec.target_standard_id !== undefined || spec.supersedes_version_id !== undefined) throw new Error("New Standard cannot set target or superseded version");
      const slug = requireString(spec.slug);
      const layer = requireString(spec.layer);
      if (!["stable_core", "adjacent", "frontier"].includes(layer)) throw new Error("Invalid Standard layer");
      standardId = `standard:${hashCanonicalContext([orgId, slug])}`;
      standard = {
        schema_version: STANDARD_SCHEMA_VERSION,
        id: standardId,
        org_id: orgId,
        slug,
        title: requireString(spec.title),
        layer: layer as StandardLayer,
        scope: cliStandardScope(spec.scope, orgId),
        created_at: at,
        created_by: proposal.author,
        citation_count: 0,
      };
    } else {
      if (spec.slug !== undefined || spec.title !== undefined || spec.layer !== undefined || spec.scope !== undefined) throw new Error("Revised StandardVersion cannot replace Standard identity");
      standardId = requireString(spec.target_standard_id);
      supersedesVersionId = requireString(spec.supersedes_version_id);
      if (!await host.get("standards").getStandard(orgId, standardId)) throw new Error("Standard was not found");
      if (!proposal.standard_bindings.some((binding) => binding.standard_id === standardId && binding.version_id === supersedesVersionId)) {
        throw new Error("Revision Proposal must pin the superseded StandardVersion");
      }
    }
    const body = {
      condition: requireString(spec.condition),
      action: requireString(spec.action),
      acceptance: requireString(spec.acceptance),
      boundary: requireString(spec.boundary),
      revision_trigger: requireString(spec.revision_trigger),
    };
    const version: StandardVersionRecord = {
      schema_version: STANDARD_VERSION_SCHEMA_VERSION,
      id: `standard-version:${hashCanonicalContext([orgId, proposal.id])}`,
      org_id: orgId,
      standard_id: standardId,
      proposal_id: proposal.id,
      version: requireString(spec.version),
      status: "draft",
      ...body,
      gate,
      ...(spec.trial === undefined ? {} : { trial: cliTrialConfig(spec.trial, orgId) }),
      ...(supersedesVersionId ? { supersedes_version_id: supersedesVersionId } : {}),
      body_hash: hashStandardVersionBody(body),
      created_at: at,
    };
    writeJson(stdout, await host.get("standards").commitProposalStandardVersion({
      org_id: orgId, proposal_id: proposal.id, ...(standard ? { standard } : {}), version,
    }));
  });
}

async function listStandards(options: CommandOptions, stdout: CliOutput): Promise<void> {
  const orgId = requireOption(options, "org");
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => {
    writeJson(stdout, await host.get("standards").listStandards({ org_id: orgId, limit: 100 }));
  });
}

async function getStandard(options: CommandOptions, stdout: CliOutput): Promise<void> {
  const orgId = requireOption(options, "org");
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => {
    const standard = await host.get("standards").getStandard(orgId, requireOption(options, "standard"));
    if (!standard) throw new Error("Standard was not found");
    writeJson(stdout, standard);
  });
}

async function listStandardVersions(options: CommandOptions, stdout: CliOutput): Promise<void> {
  const orgId = requireOption(options, "org");
  const standardId = requireOption(options, "standard");
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => {
    if (!await host.get("standards").getStandard(orgId, standardId)) throw new Error("Standard was not found");
    writeJson(stdout, await host.get("standards").listStandardVersions({ org_id: orgId, standard_id: standardId, limit: 100 }));
  });
}

async function getStandardVersion(options: CommandOptions, stdout: CliOutput): Promise<void> {
  const orgId = requireOption(options, "org");
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => {
    const version = await host.get("standards").getStandardVersion(orgId, requireOption(options, "version"));
    if (!version) throw new Error("StandardVersion was not found");
    writeJson(stdout, version);
  });
}

async function transitionCliStandardVersion(
  options: CommandOptions,
  stdout: CliOutput,
  now: () => string,
  status: Exclude<StandardVersionStatus, "draft">,
): Promise<void> {
  const orgId = requireOption(options, "org");
  const upgradePath = optionPath(options, "upgrade-evidence");
  const deprecationPath = optionPath(options, "deprecation-evidence");
  const replacementId = optionString(options, "replacement");
  const eventId = optionString(options, "event");
  if (status !== "active" && upgradePath) throw new Error("--upgrade-evidence is valid only when publishing active");
  if (status !== "deprecated" && (deprecationPath || replacementId || eventId)) throw new Error("Deprecation inputs are valid only when deprecating");
  if (deprecationPath && eventId) throw new Error("Provide --deprecation-evidence or --event, not both");
  const upgradeEvidence = upgradePath
    ? cliUpgradeEvidence(await readJsonObject(upgradePath, "UpgradeEvidence"))
    : undefined;
  const deprecationEvidence = deprecationPath
    ? await readEvidenceArray(deprecationPath, "Deprecation evidence")
    : eventId ? [{ kind: "document" as const, uri_or_ref: `event:${eventId}` }] : undefined;
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => {
    for (const evidence of deprecationEvidence ?? []) {
      if (!evidence.uri_or_ref.startsWith("event:")) continue;
      if (!await host.get("authority").getEvent(orgId, evidence.uri_or_ref.slice("event:".length))) {
        throw new Error("Deprecation evidence Event was not found");
      }
    }
    const version = await host.get("standards").transitionStandardVersion({
      org_id: orgId,
      version_id: requireOption(options, "version"),
      status,
      actor: { actor_type: "human", actor_id: orgId },
      transitioned_at: now(),
      ...(upgradeEvidence ? { upgrade_evidence: upgradeEvidence } : {}),
      ...(deprecationEvidence ? { deprecation_evidence: deprecationEvidence } : {}),
      ...(replacementId ? { superseded_by_version_id: replacementId } : {}),
    });
    if (!version) throw new Error("StandardVersion was not found");
    writeJson(stdout, version);
  });
}

function cliStandardScope(value: unknown, orgId: string): StandardScope {
  if (!isObject(value)) throw new Error("Standard scope must be an object");
  assertObjectKeys(value, new Set(["org_id", "team_ids", "roles", "decision_kinds"]), "Standard scope");
  if (value.org_id !== undefined && value.org_id !== orgId) throw new Error("Standard scope organization mismatch");
  return validateStandardScope({
    org_id: orgId,
    team_ids: cliStringArray(value.team_ids),
    roles: cliStringArray(value.roles),
    decision_kinds: cliStringArray(value.decision_kinds),
  }, orgId);
}

function cliTrialConfig(value: unknown, orgId: string): TrialConfig {
  if (!isObject(value)) throw new Error("Trial config must be an object");
  assertObjectKeys(value, new Set(["audience", "starts_at", "ends_at", "success_metric", "stop_condition"]), "Trial config");
  return validateTrialConfig({
    audience: cliStandardScope(value.audience, orgId),
    starts_at: requireString(value.starts_at),
    ...(value.ends_at === undefined ? {} : { ends_at: requireString(value.ends_at) }),
    success_metric: requireString(value.success_metric),
    stop_condition: requireString(value.stop_condition),
  });
}

function cliStringArray(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Expected an array of strings");
  return value.map(requireString);
}

function cliUpgradeEvidence(value: Record<string, unknown>): UpgradeEvidence {
  assertObjectKeys(value, new Set([
    "core_value_revalidated", "delivery_standardized", "unit_economics_or_roi_ok",
    "next_tier_behavioral_evidence", "rollback_safe", "waiver_reason",
  ]), "UpgradeEvidence");
  return validateUpgradeEvidence({
    core_value_revalidated: cliBoolean(value.core_value_revalidated, "core_value_revalidated"),
    delivery_standardized: cliBoolean(value.delivery_standardized, "delivery_standardized"),
    unit_economics_or_roi_ok: cliBoolean(value.unit_economics_or_roi_ok, "unit_economics_or_roi_ok"),
    next_tier_behavioral_evidence: cliBoolean(value.next_tier_behavioral_evidence, "next_tier_behavioral_evidence"),
    rollback_safe: cliBoolean(value.rollback_safe, "rollback_safe"),
    ...(value.waiver_reason === undefined ? {} : { waiver_reason: requireString(value.waiver_reason) }),
  });
}

function cliBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name} must be boolean`);
  return value;
}

async function readJsonObject(path: string, name: string): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(path, "utf8")); } catch { throw new Error(`${name} must be valid JSON`); }
  if (!isObject(parsed)) throw new Error(`${name} must be an object`);
  return parsed;
}

async function readEvidenceArray(path: string, name: string): Promise<ProposalRecord["evidence"]> {
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(path, "utf8")); } catch { throw new Error(`${name} must be valid JSON`); }
  if (!Array.isArray(parsed)) throw new Error(`${name} must be an array`);
  return parsed.map((entry) => {
    if (!isObject(entry)) throw new Error(`${name} entries must be objects`);
    assertObjectKeys(entry, new Set(["kind", "uri_or_ref", "note", "claim_ids"]), name);
    const kind = requireString(entry.kind);
    if (!["data", "demo", "user_quote", "document", "other"].includes(kind)) throw new Error(`Invalid ${name} kind`);
    return {
      kind: kind as ProposalRecord["evidence"][number]["kind"],
      uri_or_ref: requireString(entry.uri_or_ref),
      ...(entry.note === undefined ? {} : { note: requireString(entry.note) }),
      ...(entry.claim_ids === undefined ? {} : { claim_ids: cliStringArray(entry.claim_ids) }),
    };
  });
}

function assertObjectKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, name: string): void {
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected) throw new Error(`Unexpected ${name} field: ${unexpected}`);
}

function cliDigestItem(attrs: unknown, direction: string, eventId: string): { item_kind: string; text: unknown } {
  if (!isObject(attrs) || !Array.isArray(attrs.directions)) throw new Error("Invalid daily digest body");
  const bucket = attrs.directions.find((value) => isObject(value) && value.direction === direction);
  const item = isObject(bucket) && Array.isArray(bucket.items) ? bucket.items.find((value) => isObject(value) && value.event_id === eventId) : undefined;
  if (!isObject(item)) throw new Error("Daily digest item was not found");
  return item as { item_kind: string; text: unknown };
}

function cliProposalKind(itemKind: string): ProposalKind {
  if (itemKind === "hypothesis") return "hypothesis";
  if (itemKind === "new_judgment") return "new_standard";
  if (itemKind === "standard_amendment") return "revise_standard";
  throw new Error("Digest item kind cannot create a Proposal");
}