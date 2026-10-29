import { embeddingConfigFromEnv } from "@regenic/embedding-provider";
import { assertEmbeddingDescriptor, embeddingGeneration } from "@regenic/domain";
import { activateEmbeddingGeneration, AuthorityContextEvidenceSource } from "@regenic/context-engine";
import { withLocalHost } from "../host";
import { optionString, requirePositiveInteger, requireOption, requirePath, writeJson, type CliOutput, type CommandOptions } from "../cli-runtime";

export type EmbeddingCommand =
  | "context-embedding-index" | "context-embedding-status" | "context-embedding-retry"
  | "context-embedding-backfill" | "context-embedding-activate" | "context-embedding-rollback" | "context-embedding-gc";

export async function embeddingCommand(
  command: EmbeddingCommand,
  options: CommandOptions,
  env: NodeJS.ProcessEnv,
  stdout: CliOutput,
): Promise<void> {
  const config = embeddingConfigFromEnv(env);
  if (!config) throw new Error("Configure REGENIC_EMBEDDING_DRIVER=local_http before using embedding commands");
  const orgId = requireOption(options, "org");
  const limit = requirePositiveInteger(options, "max-jobs", 1);
  if (limit > 1000) throw new Error("--max-jobs must not exceed 1000");
  await withLocalHost({
    database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, embedding: config,
  }, async (host) => {
    const status = host.get("context-vector-status");
    if (status.status !== "ready") throw new Error("Vector index is unavailable");
    const generation = embeddingGeneration(host.get("embedding").descriptor, config.chunk_tokens, config.max_chunks_per_event);
    await host.get("context-vector-index").registerGeneration(orgId, generation);
    const generations = host.get("context-vector-generations");
    if (command === "context-embedding-index" || command === "context-embedding-backfill") {
      let target = generation;
      if (command === "context-embedding-backfill") {
        target = embeddingGeneration(host.get("embedding").descriptor,
          requirePositiveInteger(options, "chunk-tokens", config.chunk_tokens),
          requirePositiveInteger(options, "max-chunks", config.max_chunks_per_event));
        await host.get("context-vector-index").registerGeneration(orgId, target);
      }
      const progress = { processed: 0, failed: 0, superseded: 0 };
      for (let index = 0; index < limit; index++) {
        const result = await host.get("context-embedding-worker").runOnce();
        progress.processed += result.processed; progress.failed += result.failed; progress.superseded += result.superseded;
        if (result.processed + result.failed + result.superseded === 0) break;
      }
      writeJson(stdout, { generation: target.id, ...progress });
    } else if (command === "context-embedding-retry") {
      const selected = optionString(options, "generation") ?? generation.id;
      const retried = await host.get("context-embedding-jobs").retryQuarantined(orgId, selected, requireOption(options, "event"));
      if (!retried) throw new Error("No current quarantined embedding job matches this Event");
      writeJson(stdout, { generation: selected, retried: true });
    } else if (command === "context-embedding-activate" || command === "context-embedding-rollback") {
      const selected = requireOption(options, "generation");
      const manifest = (await generations.listGenerations(orgId)).find((entry) => entry.manifest.id === selected)?.manifest;
      if (!manifest) throw new Error("Generation is not registered");
      assertEmbeddingDescriptor(host.get("embedding").descriptor, manifest.model);
      await activateEmbeddingGeneration(orgId, selected,
        new AuthorityContextEvidenceSource(host.get("context-authority"), host.get("blobs"), true),
        host.get("context-embedding-jobs"), generations);
      writeJson(stdout, { generation: selected, active: true });
    } else if (command === "context-embedding-gc") {
      const selected = requireOption(options, "generation");
      if (selected === generation.id) throw new Error("Cannot collect the configured write generation; change configuration first");
      await generations.removeGeneration(orgId, selected);
      writeJson(stdout, { generation: selected, removed: true });
    } else {
      const selected = optionString(options, "generation") ?? generation.id;
      writeJson(stdout, { generation: selected, generations: await generations.listGenerations(orgId),
        jobs: await host.get("context-embedding-jobs").listJobs(orgId, selected) });
    }
  });
}
