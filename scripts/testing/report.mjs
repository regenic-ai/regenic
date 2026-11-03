import { spawnSync } from "node:child_process";
import { evidence, pnpm, provenance, run } from "./lib.mjs";

export function auditSummary(result) {
  if (result.error) throw result.error;
  if (result.signal || ![0, 1].includes(result.status)) throw new Error("Dependency audit did not complete");
  const report = JSON.parse(result.stdout);
  if (report.error || !report.metadata?.vulnerabilities) throw new Error("Invalid dependency audit response");
  const advisories = Object.values(report.advisories ?? {}).map((item) => ({
    id: item.github_advisory_id ?? item.id,
    module: item.module_name, severity: item.severity,
    vulnerable_versions: item.vulnerable_versions, patched_versions: item.patched_versions,
  }));
  return {
    policy: "report-only; not a vulnerability acceptance or a regression baseline",
    vulnerabilities: report.metadata.vulnerabilities, advisories,
  };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const tree = JSON.parse(run(pnpm, ["list", "-r", "--depth", "Infinity", "--json"], { capture: true }));
  const versions = new Map();
  function collect(dependencies = {}) {
    for (const [name, value] of Object.entries(dependencies)) {
      if (!value.version.startsWith("link:")) versions.set(`${name}@${value.version}`, { name, version: value.version });
      collect(value.dependencies);
    }
  }
  for (const project of tree) {
    collect(project.dependencies);
    collect(project.devDependencies);
  }
  const audit = auditSummary(spawnSync(pnpm, ["audit", "--json"], {
    encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
  }));
  evidence("dependencies", { ...provenance(), packages: [...versions.values()].sort((a, b) => a.name.localeCompare(b.name)), audit });
  console.log(`Dependency reporting complete: ${JSON.stringify(audit.vulnerabilities)}. Findings are report-only; audit transport/schema errors fail.`);
}
