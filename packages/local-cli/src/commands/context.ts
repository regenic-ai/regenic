import { appendFile, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  ContextQuestionAnswerer,
  evaluateContextRetrieval,
  type ContextEvaluationDataset,
} from "@regenic/context-engine";
import {
  diffContextBundles,
  EVIDENCE_BUNDLE_SCHEMA_VERSION,
  projectEvidenceBundleV1,
  type ContextConsumer,
  type ContextRequest,
  type EvidenceBundle,
} from "@regenic/domain";
import { modelProviderConfigFromEnv } from "@regenic/model-provider";
import {
  optionString,
  requireOption,
  requirePath,
  requirePositiveInteger,
  writeJson,
  type CliOutput,
  type CommandOptions,
} from "../cli-runtime";
import { withLocalHost } from "../host";

class JsonlContextConsumer implements ContextConsumer {
  constructor(private readonly output: string) {}

  async publish(bundle: EvidenceBundle): Promise<void> {
    await appendFile(this.output, `${JSON.stringify(bundle)}\n`, "utf8");
  }
}

export async function publishEvidenceBundle(
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

export async function assembleContext(
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

export async function showContextSnapshot(
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

export async function listContextSnapshotHistory(
  options: CommandOptions,
  stdout: CliOutput,
): Promise<void> {
  const orgId = requireOption(options, "org");
  const limit = requirePositiveInteger(options, "limit", 20);
  if (limit > 100) {
    throw new Error("--limit must not exceed 100");
  }
  const beforeCreatedAt = optionString(options, "before-created-at");
  const beforeSnapshotId = optionString(options, "before-snapshot-id");
  if ((beforeCreatedAt === undefined) !== (beforeSnapshotId === undefined)) {
    throw new Error("--before-created-at and --before-snapshot-id must be provided together");
  }
  await withLocalHost({
    database: requirePath(options, "database"),
    blobRoot: requirePath(options, "blob-root"),
    orgId,
    model: { driver: "none" },
  }, async (host) => {
    writeJson(stdout, await host.get("context-artifacts").listSnapshotIndex({
      org_id: orgId,
      thread_id: requireOption(options, "thread"),
      principal: { actor_type: "human", actor_id: orgId },
      consumer_id: optionString(options, "consumer") ?? "local-cli",
      limit,
      ...(beforeCreatedAt === undefined ? {} : {
        before_created_at: beforeCreatedAt,
        before_snapshot_id: beforeSnapshotId,
      }),
    }));
  });
}

export async function diffContextSnapshots(
  options: CommandOptions,
  stdout: CliOutput,
): Promise<void> {
  const orgId = requireOption(options, "org");
  const grant = {
    principal: { actor_type: "human" as const, actor_id: orgId },
    consumer_id: optionString(options, "consumer") ?? "local-cli",
    purpose: optionString(options, "purpose") ?? "inspect authorized local context",
    allowed_uses: ["display" as const],
  };
  await withLocalHost({
    database: requirePath(options, "database"),
    blobRoot: requirePath(options, "blob-root"),
    orgId,
    model: { driver: "none" },
  }, async (host) => {
    const context = host.get("context");
    const from = await context.replay({
      org_id: orgId,
      snapshot_id: requireOption(options, "from-snapshot"),
      ...grant,
    });
    const to = await context.replay({
      org_id: orgId,
      snapshot_id: requireOption(options, "to-snapshot"),
      ...grant,
    });
    writeJson(stdout, diffContextBundles(from, to));
  });
}

export async function replayContext(
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

export async function publishContextEvidenceBundle(
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

export async function askContext(
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

export async function evaluateContext(
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
    ...((thread || source) ? {
      filters: {
        ...(thread ? { thread_ids: [thread] } : {}),
        ...(source ? { sources: [source] } : {}),
      },
    } : {}),
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

