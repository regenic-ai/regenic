function unused() {
  return Promise.reject(new Error("not used"));
}

exports.catalogOnlyDriver = {
  connector_type: "example-catalog",
  source: "example-catalog",
  connector_protocol: "1.0",
  install(input) {
    return {
      id: input.id,
      org_id: input.org_id,
      connector_type: "example-catalog",
      status: "enabled",
      config: { queue: String(input.config.queue ?? "default") },
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
    return { sync: false, reply: false, create: false };
  },
  resolveStreams: unused,
  resolveThreadStream: unused,
  installCatalog() {
    return {
      title: "Catalog only",
      channel_label: "Catalog only",
      description: "Declare a vocabulary. No live sync.",
      credential_hint: "none",
      singleton: true,
      fields: [
        { key: "queue", label: "Queue", required: false, default: "default" },
        { key: "api_token", label: "API token", secret: true },
      ],
    };
  },
  subjectCatalog() {
    return {
      kinds: [{ id: "example.review", label: "Review" }],
    };
  },
};
