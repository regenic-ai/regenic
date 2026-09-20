const assert = require("node:assert/strict");
const { it } = require("node:test");
const { PersonalContextService } = require("../dist/personal-context.service");

it("keeps AgentRun creation successful when derived usage projection fails", async () => {
  let storedRun = null;
  const services = {
    "context-artifacts": {
      async getSnapshot() { return { id: "snapshot-1" }; },
    },
    standards: {
      async getStandard() { return { id: "standard-1" }; },
      async getStandardVersion() {
        return { id: "version-1", standard_id: "standard-1", status: "active" };
      },
    },
    "agent-runs": {
      async getAgentRun() { return storedRun; },
      async putAgentRun(run) { storedRun = run; return run; },
    },
    "standard-usage": {
      async projectStandardUsage() { throw new Error("projection unavailable"); },
    },
  };
  const service = new PersonalContextService({
    orgId() { return "example-org"; },
    requireHost() { return { get(name) { return services[name]; } }; },
  });

  const run = await service.createAgentRun({
    client_request_id: "run-request-1",
    agent_id: "agent-1",
    intent: "Apply the release standard.",
    context_snapshot_id: "snapshot-1",
    standard_bindings: [{ standard_id: "standard-1", version_id: "version-1" }],
    input: { release_id: "release-1" },
  });

  assert.equal(run.status, "queued");
  await assert.rejects(
    service.projectAgentRunUsage(run.id),
    /projection unavailable/,
  );
});

it("returns a bounded Standard health page with a stable next cursor", async () => {
  const standards = Array.from({ length: 101 }, (_, index) => ({
    id: `standard-${index}`,
    created_at: "2026-01-01T00:00:00.000Z",
  }));
  let requested = null;
  const service = new PersonalContextService({
    orgId() { return "example-org"; },
    requireHost() {
      return {
        get(name) {
          if (name !== "standards") throw new Error(`Unexpected service: ${name}`);
          return {
            async listStandards(input) {
              requested = input;
              return standards;
            },
          };
        },
      };
    },
  });

  const page = await service.listStandardHealthCandidates("2027-12-31T00:00:00.000Z", "90");
  assert.equal(requested.limit, 101);
  assert.deepEqual(page, {
    candidates: [],
    next_after: { created_at: "2026-01-01T00:00:00.000Z", id: "standard-99" },
  });
  await assert.rejects(
    service.listStandardHealthCandidates("2027-12-31T00:00:00.000Z", "90", "2026-01-01T00:00:00.000Z"),
    /cursor requires after_created_at and after_id/,
  );
});
