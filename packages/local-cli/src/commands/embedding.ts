import { embeddingConfigFromEnv } from "@regenic/embedding-provider";
import { embeddingGeneration } from "@regenic/domain";
import { withLocalHost } from "../host";
import { requireOption, requirePath, writeJson, type CliOutput, type CommandOptions } from "../cli-runtime";

export async function embeddingCommand(
  command: "context-embedding-index" | "context-embedding-status" | "context-embedding-retry",
  options: CommandOptions,
  env: NodeJS.ProcessEnv,
  stdout: CliOutput,
): Promise<void> {
  const config = embeddingConfigFromEnv(env);
  if (!config) throw new Error("Configure REGENIC_EMBEDDING_DRIVER=local_http before using embedding commands");
  const orgId = requireOption(options, "org");
  await withLocalHost({
    database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, embedding: config,
  }, async (host) => {
    const status = host.get("context-vector-status");
    if (status.status !== "ready") throw new Error("Vector index is unavailable");
    const generation = embeddingGeneration(host.get("embedding").descriptor, config.chunk_tokens, config.max_chunks_per_event);
    await host.get("context-vector-index").registerGeneration(orgId, generation);
    if (command === "context-embedding-index") {
      writeJson(stdout, { generation: generation.id, ...await host.get("context-embedding-worker").runOnce() });
    } else if (command === "context-embedding-retry") {
      const retried = await host.get("context-embedding-jobs").retryQuarantined(orgId, generation.id, requireOption(options, "event"));
      if (!retried) throw new Error("No current quarantined embedding job matches this Event");
      writeJson(stdout, { generation: generation.id, retried: true });
    } else {
      writeJson(stdout, { generation: generation.id, jobs: await host.get("context-embedding-jobs").listJobs(orgId, generation.id) });
    }
  });
}
