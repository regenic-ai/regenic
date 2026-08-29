function unused() {
  return Promise.reject(new Error("not used"));
}

const extraReviewDriver = {
  connector_type: "extra-review",
  source: "extra",
  connector_protocol: "1.0",
  install(input) {
    const maxOpen =
      typeof input.config.max_open === "string" && input.config.max_open.trim()
        ? input.config.max_open.trim()
        : "50";
    return {
      id: input.id,
      org_id: input.org_id,
      connector_type: "extra-review",
      status: "enabled",
      config: { max_open: maxOpen },
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
  resolveStreams() {
    return Promise.resolve([]);
  },
  resolveThreadStream: unused,
  installCatalog() {
    return {
      title: "Extra review",
      channel_label: "Extra review",
      description: "Test plugin.",
      credential_hint: "none",
      singleton: true,
      instance_label: "Extra queue",
      instance_detail_key: "max_open",
    };
  },
  subjectCatalog() {
    return {
      kinds: [
        { id: "extra.order_review", label: "Order review" },
        { id: "extra.lead_followup", label: "Lead follow-up" },
      ],
    };
  },
};

module.exports = { extraReviewDriver };
