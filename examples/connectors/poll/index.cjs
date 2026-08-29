exports.pollDriver = {
  connector_type: "example-poll",
  source: "example-poll",
  source_mode: "poll",
  connector_protocol: "1.0",
  install(input) {
    return {
      id: input.id,
      org_id: input.org_id,
      connector_type: "example-poll",
      status: "enabled",
      config: { base_url: String(input.config.base_url ?? "http://127.0.0.1:3999") },
      created_at: input.now,
    };
  },
  matchesThread(installation, thread) {
    return thread.source === "example-poll";
  },
  ownsThread(installation, thread) {
    return thread.source === "example-poll";
  },
  capabilities() {
    return { sync: true, reply: false, create: false };
  },
  resolveStreams(installation) {
    return Promise.resolve([streamOf(installation)]);
  },
  resolveThreadStream(installation) {
    return Promise.resolve(streamOf(installation));
  },
  installCatalog() {
    return {
      title: "Poll",
      channel_label: "Poll",
      description: "Poll a local HTTP endpoint. Use probeLocalHttp in a real package.",
      credential_hint: "none",
      fields: [
        {
          key: "base_url",
          label: "Base URL",
          default: "http://127.0.0.1:3999",
        },
      ],
    };
  },
};

function streamOf(installation) {
  return {
    stream_key: "main",
    connector: {
      source: "example-poll",
      source_mode: "poll",
      async poll() {
        return { records: [], next_cursor: null };
      },
    },
  };
}
