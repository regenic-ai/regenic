function unused() {
  return Promise.reject(new Error("not used"));
}

const extraWebhookDriver = {
  connector_type: "extra-webhook",
  source: "extra-push",
  source_mode: "webhook",
  connector_protocol: "1.0",
  install(input) {
    return {
      id: input.id,
      org_id: input.org_id,
      connector_type: "extra-webhook",
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
    return { sync: true, reply: false, create: false };
  },
  resolveStreams() {
    return Promise.resolve([]);
  },
  resolveThreadStream: unused,
  async bindWebhook() {
    return {
      source: "extra-push",
      source_mode: "webhook",
      async verifyWebhook(request) {
        return { body: request.body, verified_at: request.received_at };
      },
      async handleWebhook() {
        return {
          schema_version: "1.0",
          connector_id: "extra-webhook",
          org_id: "local-owner",
          delivery_id: "hook-1",
          received_at: new Date().toISOString(),
          records: [],
        };
      },
    };
  },
  installCatalog() {
    return {
      title: "Extra webhook",
      channel_label: "Extra webhook",
      description: "Test webhook plugin.",
      credential_hint: "none",
      singleton: true,
    };
  },
};

module.exports = { extraWebhookDriver };
