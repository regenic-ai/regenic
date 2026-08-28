const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  CONNECTOR_PROTOCOL,
  envCredentialsRef,
  isSupportedConnectorProtocol,
  keychainCredentialsRef,
  parseCredentialsRef,
  readEnvCredential,
  requireEnvCredentialName,
} = require("../dist");

describe("credentials_ref", () => {
  it("parses env and keychain refs", () => {
    assert.deepEqual(parseCredentialsRef("env:REGENIC_SLACK_TOKEN"), {
      kind: "env",
      name: "REGENIC_SLACK_TOKEN",
    });
    assert.deepEqual(parseCredentialsRef("keychain:lark-cli"), {
      kind: "keychain",
      name: "lark-cli",
    });
    assert.equal(parseCredentialsRef("secret:foo"), undefined);
    assert.equal(parseCredentialsRef("env:"), undefined);
    assert.equal(envCredentialsRef("REGENIC_DSH_TOKEN"), "env:REGENIC_DSH_TOKEN");
    assert.equal(keychainCredentialsRef("lark-cli"), "keychain:lark-cli");
  });

  it("reads env credentials and leaves keychain to the connector", () => {
    const env = { REGENIC_SLACK_TOKEN: " xoxb-1 " };
    assert.equal(
      readEnvCredential("env:REGENIC_SLACK_TOKEN", env),
      "xoxb-1",
    );
    assert.equal(
      readEnvCredential(undefined, env, "REGENIC_SLACK_TOKEN"),
      "xoxb-1",
    );
    assert.equal(readEnvCredential("keychain:lark-cli", env), undefined);
    assert.equal(requireEnvCredentialName(undefined, "REGENIC_SLACK_TOKEN"), "REGENIC_SLACK_TOKEN");
    assert.throws(() => requireEnvCredentialName("keychain:lark-cli"));
  });
});

describe("connector_protocol", () => {
  it("accepts 1.0 and treats a missing version as 1.0", () => {
    assert.equal(CONNECTOR_PROTOCOL, "1.0");
    assert.equal(isSupportedConnectorProtocol(undefined), true);
    assert.equal(isSupportedConnectorProtocol("1.0"), true);
    assert.equal(isSupportedConnectorProtocol("2.0"), false);
  });
});
