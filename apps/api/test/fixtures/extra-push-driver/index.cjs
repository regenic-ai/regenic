function unused() {
  return Promise.reject(new Error("not used"));
}

function event(externalId, source) {
  return {
    operation: "create",
    source,
    external_id: externalId,
    occurred_at: "2026-11-16T00:00:00.000Z",
    actor: { id: "user" },
    scope: { id: "personal" },
    type: "message",
    content: [{ role: "body", media_type: "text/plain", text: externalId }],
  };
}

function pushDriver(connectorType, source, capabilities, hooks = {}, sourceMode = "webhook") {
  return {
    connector_type: connectorType,
    source,
    source_mode: sourceMode,
    connector_protocol: "1.0",
    install(input) {
      return {
        id: input.id,
        org_id: input.org_id,
        connector_type: connectorType,
        status: "enabled",
        config: {},
        created_at: input.now,
      };
    },
    matchesThread() {
      return false;
    },
    ownsThread() {
      return false;
    },
    capabilities() {
      return { sync: true, reply: false, create: false, ...capabilities };
    },
    resolveStreams() {
      return Promise.resolve([]);
    },
    resolveThreadStream: unused,
    installCatalog() {
      return {
        title: connectorType,
        description: "Test push plugin.",
        credential_hint: "none",
      };
    },
    ...hooks,
  };
}

module.exports = {
  extraPushDriver: pushDriver("extra-push", "pushed", { push: true }),
  extraReconcileDriver: pushDriver("extra-reconcile", "reconciled", { push: true }, {
    async reconcilePush(_installation, _host, context) {
      const page = await context.listWatermarks({ stream_keys: ["chat-gap"] });
      if (page.watermarks.some((row) => row.stream_key === "chat-gap")) {
        return { repushed_batches: 0 };
      }
      await context.push({
        stream_key: "chat-gap",
        batch_id: "reconcile-gap",
        events: [event("gap-1", "reconciled")],
        watermark: "gap-w1",
      });
      return { repushed_batches: 1 };
    },
  }),
  extraHybridDriver: pushDriver("extra-hybrid", "hybrid-pushed", { push: true }, {}, "hybrid"),
  extraSilentDriver: pushDriver("extra-silent", "silent", {}),
};
