const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  CONNECTOR_PROTOCOL,
  appCredentialsRef,
  envCredentialsRef,
  isLiveCredentialKind,
  isSupportedConnectorProtocol,
  keychainCredentialsRef,
  oauthCredentialsRef,
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
    assert.deepEqual(parseCredentialsRef("oauth:dingtalk-user"), {
      kind: "oauth",
      name: "dingtalk-user",
    });
    assert.deepEqual(parseCredentialsRef("app:wecom-tenant"), {
      kind: "app",
      name: "wecom-tenant",
    });
    assert.equal(parseCredentialsRef("secret:foo"), undefined);
    assert.equal(parseCredentialsRef("env:"), undefined);
    assert.equal(envCredentialsRef("REGENIC_DSH_TOKEN"), "env:REGENIC_DSH_TOKEN");
    assert.equal(keychainCredentialsRef("lark-cli"), "keychain:lark-cli");
    assert.equal(oauthCredentialsRef("dingtalk-user"), "oauth:dingtalk-user");
    assert.equal(appCredentialsRef("wecom-tenant"), "app:wecom-tenant");
    assert.equal(isLiveCredentialKind("env"), true);
    assert.equal(isLiveCredentialKind("keychain"), true);
    assert.equal(isLiveCredentialKind("oauth"), false);
    assert.equal(isLiveCredentialKind("app"), false);
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
    assert.equal(readEnvCredential("oauth:dingtalk-user", env), undefined);
    assert.equal(readEnvCredential("app:wecom-tenant", env), undefined);
    assert.equal(requireEnvCredentialName(undefined, "REGENIC_SLACK_TOKEN"), "REGENIC_SLACK_TOKEN");
    assert.throws(() => requireEnvCredentialName("keychain:lark-cli"));
    assert.throws(() => requireEnvCredentialName("oauth:dingtalk-user"));
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
