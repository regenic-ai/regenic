const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const path = require("node:path");

const requireFromConsumer = createRequire(path.join(process.env.CONSUMER_ROOT, "entry.cjs"));
const contract = requireFromConsumer("@regenic/connector-contract");
const { createHost, definePlugin } = requireFromConsumer("@regenic/plugin-host");
const utils = requireFromConsumer("@regenic/connector-test-utils");

assert.equal(contract.CONNECTOR_PROTOCOL, "1.0");
assert.equal(typeof utils.verifyChannelDriverConformance, "function");
async function main() {
  const host = await createHost();
  try {
    await host.plugin(definePlugin({
      name: "packed-sdk-consumer",
      apply(context) {
        context.provide("contract-probe", { protocol: contract.CONNECTOR_PROTOCOL });
      },
    }));
    assert.deepEqual(host.get("contract-probe"), { protocol: "1.0" });
    const error = new contract.ChannelDriverError("sync_failed", "synthetic", "lifecycle_failed");
    assert.ok(error instanceof contract.ChannelDriverError);
    console.log("PASS: packed plugin-host loads a packed SDK plugin; contract exports and error identity are intact");
  } finally {
    await host.dispose();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
