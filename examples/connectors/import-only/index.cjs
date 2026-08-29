const { createHash } = require("node:crypto");

function unused() {
  return Promise.reject(new Error("not used"));
}

exports.importOnlyDriver = {
  connector_type: "example-import",
  source: "example-import",
  connector_protocol: "1.0",
  install(input) {
    return {
      id: input.id,
      org_id: input.org_id,
      connector_type: "example-import",
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
    return { sync: false, reply: false, create: false };
  },
  resolveStreams: unused,
  resolveThreadStream: unused,
  installCatalog() {
    return {
      title: "Import only",
      channel_label: "Import only",
      description: "Translate a user-picked file. The kernel writes Events.",
      credential_hint: "none",
      singleton: true,
      import_files: {
        accept: ".txt,.csv",
        title: "Import a text export",
      },
    };
  },
  parseImport(input) {
    const text = String(input.content ?? "").trim();
    return {
      file_hash: createHash("sha256").update(text).digest("hex"),
      batches: text
        ? [
            {
              schema_version: "1.0",
              connector_id: "example-import",
              org_id: input.org_id,
              delivery_id: `import:${input.file_name ?? "file"}`,
              received_at: input.received_at,
              records: [
                {
                  operation: "create",
                  source: "example-import",
                  external_id: "line-1",
                  occurred_at: input.received_at,
                  actor: { id: input.local_principal_id },
                  scope: { id: "file" },
                  type: "text",
                  content: [
                    { role: "body", media_type: "text/plain", text },
                  ],
                },
              ],
            },
          ]
        : [],
      errors: text ? [] : [{ message: "file is empty" }],
    };
  },
};
