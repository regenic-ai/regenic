const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const path = require("node:path");
const { existsSync, realpathSync } = require("node:fs");

const requireFromConsumer = createRequire(path.join(process.env.CONSUMER_ROOT, "entry.cjs"));
const contract = requireFromConsumer("@regenic/connector-contract");
const { createHost, definePlugin } = requireFromConsumer("@regenic/plugin-host");
const utils = requireFromConsumer("@regenic/connector-test-utils");

const packageEntry = (requireFn, spec) => {
  let root = path.dirname(requireFn.resolve(spec));
  while (root !== path.dirname(root) && !existsSync(path.join(root, "package.json"))) {
    root = path.dirname(root);
  }
  return path.join(root, "package.json");
};

const requireFromHost = createRequire(packageEntry(requireFromConsumer, "@regenic/plugin-host"));
const requireFromUtils = createRequire(packageEntry(requireFromConsumer, "@regenic/connector-test-utils"));
const hostContractPath = packageEntry(requireFromHost, "@regenic/connector-contract");
const utilsContractPath = packageEntry(requireFromUtils, "@regenic/connector-contract");
const consumerContractPath = packageEntry(requireFromConsumer, "@regenic/connector-contract");
const hostContract = requireFromHost("@regenic/connector-contract");
const utilsContract = requireFromUtils("@regenic/connector-contract");

assert.equal(contract.CONNECTOR_PROTOCOL, "1.0");
assert.equal(typeof utils.verifyChannelDriverConformance, "function");
assert.equal(realpathSync(hostContractPath), realpathSync(consumerContractPath));
assert.equal(realpathSync(utilsContractPath), realpathSync(consumerContractPath));
assert.equal(hostContract.ChannelDriverError, contract.ChannelDriverError);
assert.equal(utilsContract.ChannelDriverError, contract.ChannelDriverError);

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
    assert.ok(error instanceof hostContract.ChannelDriverError);
    assert.ok(error instanceof utilsContract.ChannelDriverError);
    console.log("PASS: packed plugin-host and test-utils share one connector-contract instance with the consumer");
  } finally {
    await host.dispose();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
