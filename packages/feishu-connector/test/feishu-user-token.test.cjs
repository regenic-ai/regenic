const assert = require("node:assert/strict");
const { afterEach, describe, it } = require("node:test");
const {
  createLarkUserTokenSource,
  feishuOpenApiBaseUrl,
  isFeishuTokenError,
  FeishuApiError,
  larkCliTokenAccount,
  parseLarkCliIdentity,
  parseStoredLarkUserToken,
  resetLarkUserTokenCache,
} = require("../dist");

afterEach(() => {
  resetLarkUserTokenCache();
});

describe("lark user token", () => {
  it("reads the current app and user from lark-cli config JSON", () => {
    const identity = parseLarkCliIdentity({
      currentApp: "work",
      apps: [
        { appId: "cli_other", users: [{ userOpenId: "ou_x" }] },
        {
          name: "work",
          appId: "cli_1",
          brand: "feishu",
          users: [{ userOpenId: "ou_1", userName: "Ada" }],
        },
      ],
    });
    assert.deepEqual(identity, {
      app_id: "cli_1",
      user_open_id: "ou_1",
      brand: "feishu",
    });
    assert.equal(larkCliTokenAccount("cli_1", "ou_1"), "cli_1:ou_1");
  });

  it("parses the keychain UAT JSON", () => {
    const stored = parseStoredLarkUserToken({
      accessToken: "u-1",
      expiresAt: 1_700_000_000_000,
    });
    assert.deepEqual(stored, {
      access_token: "u-1",
      expires_at: 1_700_000_000_000,
    });
  });

  it("returns a cached access token and refreshes through lark-cli when stale", async () => {
    let now = 1_700_000_000_000;
    let refreshed = false;
    const spawned = [];
    const source = createLarkUserTokenSource({
      now: () => now,
      async readIdentity() {
        return { app_id: "cli_1", user_open_id: "ou_1", brand: "feishu" };
      },
      async readSecret() {
        return JSON.stringify(
          refreshed
            ? { accessToken: "u-new", expiresAt: 1_700_001_200_000 }
            : { accessToken: "u-old", expiresAt: 1_700_000_600_000 },
        );
      },
      async spawn(input) {
        spawned.push(input.command);
        refreshed = true;
        return { stdout: "{}", stderr: "", exit_code: 0 };
      },
    });
    assert.equal(await source.token(), "u-old");
    now = 1_700_000_500_000;
    assert.equal(await source.token(), "u-new");
    assert.deepEqual(spawned, [["lark-cli", "auth", "status", "--verify", "--json"]]);
  });

  it("maps Feishu and Lark API hosts and token errors", () => {
    assert.equal(feishuOpenApiBaseUrl("feishu"), "https://open.feishu.cn");
    assert.equal(feishuOpenApiBaseUrl("lark"), "https://open.larksuite.com");
    assert.equal(isFeishuTokenError(new FeishuApiError("token invalid", "99991663")), true);
    assert.equal(isFeishuTokenError(new FeishuApiError("not in chat", "230002")), false);
  });

  it("builds Windows credential targets for keytar-compatible storage", () => {
    const { windowsCredentialTargets } = require("../dist");
    assert.deepEqual(windowsCredentialTargets("lark-cli", "cli_1:ou_1"), [
      "lark-cli:cli_1:ou_1",
      "cli_1:ou_1",
    ]);
    assert.deepEqual(windowsCredentialTargets("  ", "cli_1:ou_1"), []);
  });
});
