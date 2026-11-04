const { readFileSync, realpathSync } = require("node:fs");
const { join, resolve } = require("node:path");

function assertCandidatePackage(actual, candidate, expectedVersion) {
  const actualPath = actual.manifest_realpath;
  const candidatePath = candidate.manifest_realpath;
  if (actualPath !== candidatePath) {
    throw new Error(
      `Candidate package resolved outside the packed candidate: ${actualPath}`,
    );
  }
  if (actual.version !== expectedVersion || candidate.version !== expectedVersion) {
    throw new Error(
      `Candidate package version mismatch: expected ${expectedVersion}, actual ${actual.version}`,
    );
  }
}

function assertPackageVersion(actual, expectedVersion, label) {
  if (actual.version !== expectedVersion) {
    throw new Error(`${label} version mismatch: expected ${expectedVersion}, got ${actual.version}`);
  }
}

function assertRuntimeOverride(override, actualPackage, expectedVersion, label) {
  if (typeof override !== "string" || !override.includes(expectedVersion)) {
    throw new Error(`${label} manifest override does not declare ${expectedVersion}`);
  }
  assertPackageVersion(actualPackage, expectedVersion, label);
}

function parseAuditResult(result) {
  if (result.error) {
    throw new Error(`pnpm audit could not complete: ${result.error.message}`);
  }
  if (result.status === null || result.signal) {
    throw new Error(`pnpm audit did not complete: ${result.signal ?? "unknown process status"}`);
  }
  if (/(?:ERR_PNPM_AUDIT|ECONN(?:RESET|REFUSED)|ENOTFOUND|ETIMEDOUT|fetch failed|network error)/i.test(result.stderr ?? "")) {
    throw new Error("pnpm audit reported a transport or registry error");
  }

  let parsed;
  try {
    parsed = JSON.parse((result.stdout ?? "").trim());
  } catch (error) {
    throw new Error(`pnpm audit returned invalid JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== "object" || parsed.error) {
    throw new Error("pnpm audit returned an error or non-object report");
  }
  const hasReport =
    Object.hasOwn(parsed, "advisories") ||
    Object.hasOwn(parsed, "metadata") ||
    Object.hasOwn(parsed, "auditReportVersion") ||
    Object.hasOwn(parsed, "vulnerabilities");
  if (!hasReport) {
    throw new Error("pnpm audit JSON does not contain a recognized audit report");
  }
  return parsed;
}

function assertInstalledTarball(prefix, name, artifact, actual) {
  const lock = JSON.parse(readFileSync(join(prefix, "package-lock.json"), "utf8"));
  const lockKey = `node_modules/@regenic/${name}`;
  const lockEntry = lock.packages?.[lockKey];
  if (!lockEntry?.resolved || !lockEntry?.integrity) {
    throw new Error(`Candidate SDK lock entry is missing file resolution or integrity: ${name}`);
  }
  const lockTarball = realpathSync(resolve(prefix, lockEntry.resolved.replace(/^file:/, "")));
  if (lockTarball !== realpathSync(artifact.path)) {
    throw new Error(`Candidate SDK ${name} did not resolve from its packed tarball`);
  }
  const expectedIntegrity = `sha512-${Buffer.from(artifact.sha512, "hex").toString("base64")}`;
  if (lockEntry.integrity !== expectedIntegrity) {
    throw new Error(`Candidate SDK ${name} lock integrity does not match packed tarball`);
  }
  const expectedManifest = realpathSync(join(prefix, "node_modules", "@regenic", name, "package.json"));
  assertCandidatePackage(actual, { manifest_realpath: expectedManifest, version: artifact.version }, artifact.version);
  return {
    ...actual,
    tarball_sha512: artifact.sha512,
    lock_key: lockKey,
    lock_resolved: lockEntry.resolved,
    lock_integrity: lockEntry.integrity,
  };
}

module.exports = {
  assertInstalledTarball,
  assertCandidatePackage,
  assertPackageVersion,
  assertRuntimeOverride,
  parseAuditResult,
};
