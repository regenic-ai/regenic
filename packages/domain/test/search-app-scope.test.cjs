const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  contextFiltersForAppClass,
  matchesSearchAppScope,
  mergeSearchAgentScope,
  parseSearchAgentScope,
  searchAgentScope,
} = require("@regenic/domain");

describe("search app scope", () => {
  it("treats a whole agent source separately from a shared source prefix", () => {
    assert.deepEqual(searchAgentScope([
      { source: "feishu", agent: false },
      { source: "dsh", agent: true },
      { source: "dsh", agent: true },
      { source: "server_app", agent: false, thread_prefix: "server_app:notes:inst-2:" },
      { source: "server_app", agent: true, thread_prefix: "server_app:demo:inst-1:" },
      { source: "cursor", agent: true },
      { source: "cursor", agent: true, thread_prefix: "cursor:ignored:" },
    ]), {
      agent_sources: ["cursor", "dsh"],
      agent_thread_prefixes: ["server_app:demo:inst-1:"],
    });
  });

  it("leaves an ordinary search unchanged when nothing is an agent app", () => {
    assert.equal(contextFiltersForAppClass(
      { sources: ["feishu"] },
      "app",
      { agent_sources: [], agent_thread_prefixes: [] },
    ).sources[0], "feishu");
    assert.equal(contextFiltersForAppClass(
      undefined,
      "app",
      { agent_sources: [], agent_thread_prefixes: [] },
    ), undefined);
  });

  it("matches nothing for an agent search when no agent app is installed", () => {
    const filters = contextFiltersForAppClass(undefined, "agent", {
      agent_sources: [],
      agent_thread_prefixes: [],
    });
    assert.equal(filters.app_scope.class, "agent");
    assert.equal(matchesSearchAppScope({ source: "feishu", thread_id: "feishu:1" }, filters.app_scope), false);
  });

  it("keeps ordinary threads of a shared source", () => {
    const scope = {
      class: "app",
      agent_sources: ["dsh"],
      agent_thread_prefixes: ["server_app:demo:inst-1:"],
    };
    assert.equal(matchesSearchAppScope({ source: "feishu", thread_id: "feishu:1" }, scope), true);
    assert.equal(matchesSearchAppScope({ source: "dsh", thread_id: "dsh:session" }, scope), false);
    assert.equal(matchesSearchAppScope({
      source: "server_app",
      thread_id: "server_app:demo:inst-1:room",
    }, scope), false);
    assert.equal(matchesSearchAppScope({
      source: "server_app",
      thread_id: "server_app:notes:inst-2:room",
    }, scope), true);
    assert.equal(matchesSearchAppScope({
      source: "server_app",
      thread_id: "server_app:demo:inst-1:room",
    }, { ...scope, class: "agent" }), true);
  });

  it("keeps a retained prefix after the installation is gone", () => {
    const retained = {
      agent_sources: ["dsh"],
      agent_thread_prefixes: ["server_app:demo:inst-1:"],
    };
    assert.deepEqual(mergeSearchAgentScope(retained, {
      agent_sources: [],
      agent_thread_prefixes: [],
    }), retained);
    assert.deepEqual(mergeSearchAgentScope({
      agent_sources: ["cursor"],
      agent_thread_prefixes: ["server_app:demo:inst-1:extra"],
    }, retained), {
      agent_sources: ["cursor", "dsh"],
      agent_thread_prefixes: ["server_app:demo:inst-1:", "server_app:demo:inst-1:extra"],
    });
    assert.deepEqual(parseSearchAgentScope({
      agent_sources: ["dsh", ""],
      agent_thread_prefixes: ["server_app:demo:inst-1:", "not-a-prefix", 3],
    }), {
      agent_sources: ["dsh"],
      agent_thread_prefixes: ["server_app:demo:inst-1:"],
    });
  });
});
