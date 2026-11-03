import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  evidence, hash, isolatedEnvironment, npm, pnpm, provenance,
  packedArtifact, removeRoot, repo, requireRuntime, run, temporaryRoot,
} from "./lib.mjs";

requireRuntime();
const require = createRequire(join(repo, "packages/connector-contract/package.json"));
const { CONNECTOR_PROTOCOL } = require("@regenic/connector-contract");
const root = temporaryRoot("consumer");
const packDir = join(root, "packs");
const consumerDir = join(root, "consumer");
const env = { ...isolatedEnvironment(root), CONSUMER_ROOT: consumerDir };
const packed = [];
try {
  await import("node:fs/promises").then(({ mkdir }) => mkdir(packDir, { recursive: true }));
  await import("node:fs/promises").then(({ mkdir }) => mkdir(consumerDir, { recursive: true }));
  for (const name of ["plugin-host", "connector-contract", "connector-test-utils"]) {
    const directory = join(repo, "packages", name);
    const output = run(pnpm, ["pack", "--pack-destination", packDir], { cwd: directory, env, capture: true });
    const path = packedArtifact(output, packDir);
    packed.push({ name, path, sha512: hash(path) });
  }
  run(npm, ["install", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund",
    "--prefix", consumerDir, ...packed.map((entry) => entry.path)], { env });
  run(npm, ["install", "--ignore-scripts", "--no-audit", "--no-fund",
    "--prefix", consumerDir, "--save-dev", "typescript@5.9.3", "@types/node@22.20.5"], { env });
  const typeProbe = join(consumerDir, "sdk-contract-smoke.ts");
  const tsconfig = join(consumerDir, "tsconfig.consumer-smoke.json");
  writeFileSync(typeProbe, `
import type {
  ExecutorContext,
  ExecutorStartInput,
  ExecutorResumeInput,
  ExecutorRunHandle,
  TaskExecutor,
  WorkRun,
} from "@regenic/connector-contract";

const assertCtx = (ctx: ExecutorContext): string | undefined => ctx.installation_id;

const executor: TaskExecutor = {
  executor_type: "packed-sdk-consumer-smoke",
  capabilities() {
    return { start: true, resume: true, status: true };
  },
  catalog() {
    return { executor_type: "packed-sdk-consumer-smoke", label: "smoke", fields: [] };
  },
  async start(_input: ExecutorStartInput, _ctx: ExecutorContext): Promise<ExecutorRunHandle> {
    throw new Error("smoke");
  },
  async resume(_input: ExecutorResumeInput, _ctx: ExecutorContext): Promise<ExecutorRunHandle> {
    throw new Error("smoke");
  },
  async status(_run: WorkRun, _ctx: ExecutorContext): Promise<ExecutorRunHandle> {
    throw new Error("smoke");
  },
  async cancel(_run: WorkRun, _ctx: ExecutorContext): Promise<void> {},
};
void assertCtx;
void executor;
`, "utf8");
  writeFileSync(tsconfig, JSON.stringify({
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      esModuleInterop: true,
      types: ["node"],
    },
    files: ["sdk-contract-smoke.ts"],
  }, null, 2), "utf8");
  run(npm, ["exec", "--prefix", consumerDir, "tsc", "--", "-p", "tsconfig.consumer-smoke.json"], {
    cwd: consumerDir, env,
  });
  run(process.execPath, [join(repo, "scripts/testing/consumer-probe.cjs")], { env });
  evidence("packed-consumer", {
    ...provenance(), status: "passed", contract_protocol: CONNECTOR_PROTOCOL,
    packages: packed.map(({ name, sha512 }) => ({ name, sha512 })),
    install_mode: "npm install --ignore-scripts --omit=dev",
    typescript_contract_smoke: "strict --noEmit sdk-contract-smoke.ts",
    zod_note: "This verifies packed SDK identity only; source-root override behavior is validated in connector-specific clone-root lanes.",
  });
} finally {
  removeRoot(root);
}
