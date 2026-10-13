import {
  requireOption,
  requirePath,
  writeJson,
  type CliOutput,
  type CommandOptions,
} from "../cli-runtime";
import { withLocalHost } from "../host";

export async function projectDailyDigest(options: CommandOptions, stdout: CliOutput): Promise<void> {
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

export async function getDailyDigests(options: CommandOptions, stdout: CliOutput): Promise<void> {
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

export async function getDailyDigestJobs(options: CommandOptions, stdout: CliOutput): Promise<void> {
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

export async function getDailyDigestCoverageAlerts(options: CommandOptions, stdout: CliOutput): Promise<void> {
  const orgId = requireOption(options, "org");
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => {
    const alerts = await host.get("daily-digest-coverage-alerts").listDailyDigestCoverageAlerts({ org_id: orgId, status: "open", limit: 100 });
    writeJson(stdout, alerts.map(({ event_id, org_id, ...alert }) => alert));
  });
}

export async function resolveDailyDigestCoverageAlert(options: CommandOptions, stdout: CliOutput, now: () => string): Promise<void> {
  const orgId = requireOption(options, "org");
  await withLocalHost({ database: requirePath(options, "database"), blobRoot: requirePath(options, "blob-root"), orgId, model: { driver: "none" } }, async (host) => {
    const value = await host.get("daily-digest-coverage-alerts").resolveDailyDigestCoverageAlert({ org_id: orgId, alert_id: requireOption(options, "alert"), resolved_at: now() });
    if (!value) throw new Error("Coverage alert was not found");
    const { event_id, org_id, ...alert } = value;
    writeJson(stdout, alert);
  });
}

