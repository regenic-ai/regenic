import { join } from "node:path";
import {
  evidence, isolatedEnvironment, pnpm, provenance, removeRoot, repo,
  requireRuntime, run, temporaryRoot,
} from "./lib.mjs";

requireRuntime();
const lane = process.argv[2];
if (!["pr", "host", "soak", "desktop"].includes(lane)) {
  throw new Error("Usage: node scripts/testing/run.mjs pr|host|soak|desktop");
}
const root = temporaryRoot(lane);
const env = isolatedEnvironment(root);
const metadata = { ...provenance(), lane, status: "failed" };
const command = (args) => run(pnpm, args, { env });
const host = () => run(process.execPath, ["--test",
  "test/host-executor-integration.test.cjs",
  "test/connector-installation-lifecycle.test.cjs",
  "test/local-executor-cancellation.test.cjs",
  "test/personal-reply-recovery.test.cjs",
], { cwd: join(repo, "apps/api"), env });
try {
  if (lane === "pr") {
    run(process.execPath, ["scripts/connectors/check-official-market-index.mjs"], { env });
    command(["test:tooling"]);
    command(["check:boundaries"]);
    command(["build"]);
    command(["typecheck"]);
    command(["test"]);
    command(["test:consumer"]);
  } else if (lane === "desktop") {
    command(["--filter", "@regenic/api...", "build"]);
    command(["--filter", "@regenic/desktop", "test"]);
    command(["--filter", "@regenic/desktop", "build"]);
    command(["--filter", "@regenic/desktop", "test:semantic:electron"]);
  } else {
    command(["--filter", "@regenic/api...", "build"]);
    const iterations = lane === "soak" ? Number(process.env.REGENIC_SOAK_ITERATIONS ?? 10) : 1;
    if (!Number.isInteger(iterations) || iterations < 1 || iterations > 100) {
      throw new Error("REGENIC_SOAK_ITERATIONS must be an integer from 1 to 100");
    }
    for (let iteration = 0; iteration < iterations; iteration++) host();
    metadata.iterations = iterations;
  }
  metadata.status = "passed";
} finally {
  removeRoot(root);
  evidence(`lane-${lane}`, metadata);
}
