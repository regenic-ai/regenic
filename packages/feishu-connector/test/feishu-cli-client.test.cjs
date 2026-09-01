const assert = require("node:assert/strict");
const { afterEach, describe, it } = require("node:test");
const {
  FeishuApiError,
  LarkCliClient,
  appendFeishuOpenApiParams,
  isTransientLarkError,
  feishuChatOptionLabel,
  larkCliCatalogHint,
  larkCliUserReady,
  parseChatPage,
  parseHistoryPage,
  parseUserNamePage,
  listFeishuCatalogChats,
  probeLarkCli,
  probeLarkCliAuth,
  resetFeishuChatListCache,
  resetFeishuChatInfoCache,
  resetFeishuUserNameCache,
  resetLarkCliProbeCache,
  resetLarkCliSlot,
  resetLarkUserTokenCache,
  resolveLarkCommand,
  unwrapLarkCli,
} = require("../dist");

afterEach(() => {
  resetLarkCliSlot();
  resetLarkUserTokenCache();
  resetFeishuUserNameCache();
  resetFeishuChatInfoCache();
});

describe("LarkCliClient", () => {
  it("lists messages as the user and unwraps the CLI envelope", async () => {
    const calls = [];
    const client = new LarkCliClient({
      command: "lark-cli",
      async spawn(input) {
        calls.push(input);
        return {
          stdout: JSON.stringify({
            ok: true,
            identity: "user",
            data: {
              items: [{ message_id: "om_1", msg_type: "text" }],
              has_more: true,
              page_token: "next",
            },
          }),
          stderr: "",
          exit_code: 0,
        };
      },
    });

    const page = await client.listMessages({
      chat_id: "oc_1",
      page_size: 20,
      page_token: "cur",
      start_time: "1723420800",
    });

    assert.deepEqual(calls[0].command, [
      "lark-cli",
      "api",
      "GET",
      "/open-apis/im/v1/messages",
      "--as",
      "user",
      "--format",
      "json",
      "--params",
      JSON.stringify({
        container_id_type: "chat",
        container_id: "oc_1",
        sort_type: "ByCreateTimeAsc",
        page_size: 20,
        page_token: "cur",
        start_time: "1723420800",
      }),
    ]);
    assert.equal(page.items[0].message_id, "om_1");
    assert.equal(page.has_more, true);
    assert.equal(page.page_token, "next");
  });

  it("lists messages over HTTP when a user token is available", async () => {
    const spawned = [];
    const fetched = [];
    const client = new LarkCliClient({
      command: "lark-cli",
      async spawn(input) {
        spawned.push(input);
        throw new Error("CLI should not run when HTTP works");
      },
      userToken: {
        async token() {
          return "u-test";
        },
        async refresh() {},
        async identity() {
          return { app_id: "cli_1", user_open_id: "ou_1", brand: "feishu" };
        },
        async brand() {
          return "feishu";
        },
      },
      async fetch(url, init) {
        fetched.push({ url, init });
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({
              code: 0,
              data: {
                items: [{ message_id: "om_http", msg_type: "text" }],
                has_more: false,
              },
            });
          },
          async json() {
            return JSON.parse(await this.text());
          },
        };
      },
    });
    const page = await client.listMessages({
      chat_id: "oc_1",
      page_size: 50,
      sort_type: "ByCreateTimeDesc",
    });
    assert.equal(spawned.length, 0);
    assert.equal(page.items[0].message_id, "om_http");
    assert.match(fetched[0].url, /open\.feishu\.cn\/open-apis\/im\/v1\/messages/);
    assert.match(fetched[0].url, /sort_type=ByCreateTimeDesc/);
    assert.equal(fetched[0].init.headers.Authorization, "Bearer u-test");
  });

  it("does not fall back to CLI when HTTP is temporarily unhealthy", async () => {
    const spawned = [];
    let attempts = 0;
    const client = new LarkCliClient({
      command: "lark-cli",
      async spawn(input) {
        spawned.push(input);
        throw new Error("CLI should not run for transient HTTP failures");
      },
      userToken: {
        async token() {
          return "u-test";
        },
        async refresh() {},
        async identity() {
          return { app_id: "cli_1", user_open_id: "ou_1", brand: "feishu" };
        },
        async brand() {
          return "feishu";
        },
      },
      async fetch() {
        attempts += 1;
        throw new Error("socket hang up");
      },
    });
    await assert.rejects(
      () =>
        client.listMessages({
          chat_id: "oc_1",
          page_size: 50,
          sort_type: "ByCreateTimeDesc",
        }),
      /socket hang up|Feishu HTTP request failed/,
    );
    assert.equal(spawned.length, 0);
    assert.ok(attempts >= 1);
  });

  it("lists groups over HTTP when a user token is available", async () => {
    const spawned = [];
    const fetched = [];
    const client = new LarkCliClient({
      command: "lark-cli",
      async spawn(input) {
        spawned.push(input);
        throw new Error("CLI should not run when HTTP works");
      },
      userToken: {
        async token() {
          return "u-test";
        },
        async refresh() {},
        async identity() {
          return { app_id: "cli_1", user_open_id: "ou_1", brand: "feishu" };
        },
        async brand() {
          return "feishu";
        },
      },
      async fetch(url, init) {
        fetched.push({ url, init });
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({
              code: 0,
              data: {
                items: [{ chat_id: "oc_http", name: "Eng" }],
                has_more: true,
                page_token: "g2",
              },
            });
          },
          async json() {
            return JSON.parse(await this.text());
          },
        };
      },
    });
    const page = await client.listChats({
      page_size: 100,
      types: ["group"],
      names: false,
    });
    assert.equal(spawned.length, 0);
    assert.equal(page.items[0].chat_id, "oc_http");
    assert.equal(page.items[0].chat_mode, "group");
    assert.equal(page.has_more, true);
    assert.match(fetched[0].url, /open\.feishu\.cn\/open-apis\/im\/v1\/chats/);
    assert.match(fetched[0].url, /sort_type=ByActiveTimeDesc/);
    assert.equal(fetched[0].init.headers.Authorization, "Bearer u-test");
  });

  it("loads one chat by id over HTTP and caches the name", async () => {
    const fetched = [];
    const client = new LarkCliClient({
      command: "lark-cli",
      async spawn() {
        throw new Error("CLI should not run when HTTP works");
      },
      userToken: {
        async token() {
          return "u-test";
        },
        async refresh() {},
        async identity() {
          return { app_id: "cli_1", user_open_id: "ou_1", brand: "feishu" };
        },
        async brand() {
          return "feishu";
        },
      },
      async fetch(url, init) {
        fetched.push({ url, init });
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({
              code: 0,
              data: {
                chat_id: "oc_eng",
                name: "工程群",
                chat_mode: "group",
                chat_status: "normal",
              },
            });
          },
          async json() {
            return JSON.parse(await this.text());
          },
        };
      },
    });
    const first = await client.getChat("oc_eng");
    assert.equal(first?.name, "工程群");
    assert.equal(first?.chat_mode, "group");
    assert.match(fetched[0].url, /open\.feishu\.cn\/open-apis\/im\/v1\/chats\/oc_eng/);
    const second = await client.getChat("oc_eng");
    assert.equal(second?.name, "工程群");
    assert.equal(fetched.length, 1);
  });

  it("falls back to HTTP when CLI download fails", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const fetched = [];
    const client = new LarkCliClient({
      command: "lark-cli",
      async spawn() {
        throw new Error("CLI download unavailable");
      },
      userToken: {
        async token() {
          return "u-test";
        },
        async refresh() {},
        async identity() {
          return { app_id: "cli_1", user_open_id: "ou_1", brand: "feishu" };
        },
        async brand() {
          return "feishu";
        },
      },
      async fetch(url, init) {
        fetched.push({ url, init });
        return {
          ok: true,
          status: 200,
          headers: {
            get(name) {
              if (name === "content-type") {
                return "image/png";
              }
              if (name === "content-disposition") {
                return 'attachment; filename="shot.png"';
              }
              return null;
            },
          },
          async arrayBuffer() {
            return png.buffer;
          },
        };
      },
    });
    const file = await client.downloadResource({
      message_id: "om_img",
      file_key: "img_shot",
      type: "image",
    });
    assert.match(
      fetched[0].url,
      /open\.feishu\.cn\/open-apis\/im\/v1\/messages\/om_img\/resources\/img_shot/,
    );
    assert.match(fetched[0].url, /type=image/);
    assert.equal(file.media_type, "image/png");
    assert.equal(file.filename, "shot.png");
    assert.deepEqual(Array.from(file.bytes), Array.from(png));
  });

  it("falls back to im +messages-resources-download when HTTP returns JSON", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const calls = [];
    const client = new LarkCliClient({
      command: "lark-cli",
      userToken: {
        async token() {
          return "u-test";
        },
        async refresh() {},
        async identity() {
          return { app_id: "cli_1", user_open_id: "ou_1", brand: "feishu" };
        },
        async brand() {
          return "feishu";
        },
      },
      async fetch() {
        return {
          ok: true,
          status: 200,
          headers: {
            get(name) {
              return name === "content-type" ? "application/json" : null;
            },
          },
          async arrayBuffer() {
            return Buffer.from(JSON.stringify({ code: 99991663, msg: "token invalid" }));
          },
        };
      },
      async spawn(input) {
        calls.push(input);
        const { writeFile } = require("node:fs/promises");
        const { join } = require("node:path");
        await writeFile(join(input.cwd, "image.bin"), png);
        return {
          stdout: JSON.stringify({
            ok: true,
            data: { saved_path: "image.bin", size_bytes: png.byteLength },
          }),
          stderr: "",
          exit_code: 0,
        };
      },
    });
    const file = await client.downloadResource({
      message_id: "om_img",
      file_key: "img_shot",
      type: "image",
    });
    assert.deepEqual(calls[0].command.slice(0, 4), [
      "lark-cli",
      "im",
      "+messages-resources-download",
      "--as",
    ]);
    assert.equal(file.media_type, "image/png");
    assert.deepEqual(Array.from(file.bytes), Array.from(png));
  });

  it("retries a timed-out history page and then succeeds", async () => {
    let calls = 0;
    const client = new LarkCliClient({
      command: "lark-cli",
      async spawn() {
        calls += 1;
        if (calls === 1) {
          throw new FeishuApiError("lark-cli timed out after 60000ms");
        }
        return {
          stdout: JSON.stringify({
            ok: true,
            data: { items: [{ message_id: "om_2", msg_type: "text" }], has_more: false },
          }),
          stderr: "",
          exit_code: 0,
        };
      },
    });
    const page = await client.listMessages({ chat_id: "oc_1", page_size: 50 });
    assert.equal(calls, 2);
    assert.equal(page.items[0].message_id, "om_2");
  });

  it("does not retry an auth failure", async () => {
    let calls = 0;
    const client = new LarkCliClient({
      command: "lark-cli",
      async spawn() {
        calls += 1;
        throw new FeishuApiError("user unauthorized", "230027");
      },
    });
    await assert.rejects(
      () => client.listMessages({ chat_id: "oc_1", page_size: 50 }),
      FeishuApiError,
    );
    assert.equal(calls, 1);
    assert.equal(isTransientLarkError(new FeishuApiError("user unauthorized", "230027")), false);
  });

  it("lists groups over Open API and p2p over +chat-list", async () => {
    resetFeishuChatListCache();
    const calls = [];
    const client = new LarkCliClient({
      async spawn(input) {
        calls.push(input);
        const cmd = input.command;
        if (cmd.includes("/open-apis/im/v1/chats")) {
          return {
            stdout: JSON.stringify({
              ok: true,
              data: {
                items: [
                  {
                    chat_id: "oc_1",
                    name: "One",
                    chat_mode: "group",
                    chat_status: "normal",
                  },
                ],
                has_more: false,
              },
            }),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: JSON.stringify({
            ok: true,
            data: {
              chats: [
                {
                  chat_id: "oc_2",
                  name: "Ada",
                  chat_mode: "p2p",
                  chat_status: "normal",
                },
              ],
              has_more: false,
            },
          }),
          stderr: "",
          exit_code: 0,
        };
      },
    });
    const chats = await client.listAllChats();
    assert.equal(calls.length, 2);
    assert.equal(calls[0].command.includes("/open-apis/im/v1/chats"), true);
    assert.equal(calls[1].command.includes("+chat-list"), true);
    assert.equal(calls[1].command[calls[1].command.indexOf("--types") + 1], "p2p");
    assert.deepEqual(chats, [
      { chat_id: "oc_1", name: "One", chat_mode: "group" },
      { chat_id: "oc_2", name: "Ada", chat_mode: "p2p" },
    ]);
    const again = await client.listAllChats();
    assert.equal(calls.length, 2);
    assert.deepEqual(again, chats);
    resetFeishuChatListCache();
  });

  it("lists recent group and p2p chats in parallel without +chat-list for groups", async () => {
    resetFeishuChatListCache();
    const spawned = [];
    const fetched = [];
    const client = new LarkCliClient({
      command: "lark-cli",
      async spawn(input) {
        spawned.push(input);
        return {
          stdout: JSON.stringify({
            ok: true,
            data: {
              chats: [
                {
                  chat_id: "oc_p2p",
                  name: "Ada",
                  chat_mode: "p2p",
                  chat_status: "normal",
                },
              ],
              has_more: false,
            },
          }),
          stderr: "",
          exit_code: 0,
        };
      },
      userToken: {
        async token() {
          return "u-test";
        },
        async refresh() {},
        async identity() {
          return { app_id: "cli_1", user_open_id: "ou_1", brand: "feishu" };
        },
        async brand() {
          return "feishu";
        },
      },
      async fetch(url, init) {
        fetched.push({ url, init });
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({
              code: 0,
              data: {
                items: [
                  {
                    chat_id: "oc_group",
                    name: "Eng",
                    chat_mode: "group",
                    chat_status: "normal",
                  },
                ],
                has_more: false,
              },
            });
          },
          async json() {
            return JSON.parse(await this.text());
          },
        };
      },
    });
    const chats = await client.listRecentChats(["group", "p2p"], { names: false });
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].command.includes("+chat-list"), true);
    assert.equal(
      spawned[0].command[spawned[0].command.indexOf("--types") + 1],
      "p2p",
    );
    assert.equal(fetched.length, 1);
    assert.match(fetched[0].url, /open\.feishu\.cn\/open-apis\/im\/v1\/chats/);
    assert.deepEqual(chats, [
      { chat_id: "oc_group", name: "Eng", chat_mode: "group" },
      { chat_id: "oc_p2p", name: "Ada", chat_mode: "p2p" },
    ]);
    resetFeishuChatListCache();
  });

  it("lists only the latest chat page without resolving p2p names", async () => {
    resetFeishuChatListCache();
    const calls = [];
    const client = new LarkCliClient({
      async spawn(input) {
        calls.push(input);
        if (input.command.includes("+search-user")) {
          return {
            stdout: JSON.stringify({
              ok: true,
              data: { users: [{ open_id: "ou_9", name: "Ben" }] },
            }),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: JSON.stringify({
            ok: true,
            data: {
              chats: [
                {
                  chat_id: "oc_bare",
                  chat_mode: "p2p",
                  p2p_target_id: "ou_9",
                  chat_status: "normal",
                },
              ],
              has_more: true,
              page_token: "p2",
            },
          }),
          stderr: "",
          exit_code: 0,
        };
      },
    });
    const chats = await client.listRecentChats(["p2p"], { names: false });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command.includes("+chat-list"), true);
    assert.deepEqual(chats, [
      {
        chat_id: "oc_bare",
        name: undefined,
        chat_mode: "p2p",
        p2p_target_id: "ou_9",
      },
    ]);
    await client.listRecentChats(["p2p"], { names: false });
    assert.equal(calls.length, 1);
    resetFeishuChatListCache();
  });

  it("coalesces concurrent chat list pagination", async () => {
    resetFeishuChatListCache();
    let calls = 0;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const client = new LarkCliClient({
      async spawn() {
        calls += 1;
        await gate;
        return {
          stdout: JSON.stringify({
            ok: true,
            data: {
              chats: [
                {
                  chat_id: "oc_1",
                  name: "One",
                  chat_mode: "group",
                  chat_status: "normal",
                },
              ],
              has_more: false,
            },
          }),
          stderr: "",
          exit_code: 0,
        };
      },
    });
    const first = client.listAllChats();
    const second = client.listAllChats();
    release();
    const [left, right] = await Promise.all([first, second]);
    assert.equal(calls, 2);
    assert.deepEqual(left, right);
    resetFeishuChatListCache();
  });

  it("drops dissolved chats from a list page and labels kinds", () => {
    const page = parseChatPage({
      chats: [
        { chat_id: "oc_ok", name: "Live", chat_mode: "group", chat_status: "normal" },
        { chat_id: "oc_dm", name: "Ada", chat_mode: "p2p", chat_status: "normal" },
        {
          chat_id: "oc_loc",
          localized_name: { zh_cn: "工程" },
          chat_mode: "group",
          chat_status: "normal",
        },
        {
          chat_id: "oc_bare",
          chat_mode: "p2p",
          p2p_target_id: "ou_9",
          chat_status: "normal",
        },
        { chat_id: "oc_dead", name: "Gone", chat_status: "dissolved" },
      ],
    });
    assert.deepEqual(page.items, [
      { chat_id: "oc_ok", name: "Live", chat_mode: "group" },
      { chat_id: "oc_dm", name: "Ada", chat_mode: "p2p" },
      { chat_id: "oc_loc", name: "工程", chat_mode: "group" },
      {
        chat_id: "oc_bare",
        name: undefined,
        chat_mode: "p2p",
        p2p_target_id: "ou_9",
      },
    ]);
    assert.equal(feishuChatOptionLabel(page.items[0]), "Group · Live");
    assert.equal(feishuChatOptionLabel(page.items[1]), "Direct · Ada");
  });

  it("fills a nameless p2p chat from p2p_target_id", async () => {
    resetFeishuChatListCache();
    resetFeishuUserNameCache();
    const calls = [];
    const client = new LarkCliClient({
      async spawn(input) {
        calls.push(input);
        if (input.command.includes("+search-user")) {
          return {
            stdout: JSON.stringify({
              ok: true,
              data: { users: [{ open_id: "ou_9", name: "Ben" }] },
            }),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: JSON.stringify({
            ok: true,
            data: {
              chats: [
                {
                  chat_id: "oc_bare",
                  chat_mode: "p2p",
                  p2p_target_id: "ou_9",
                  chat_status: "normal",
                },
              ],
              has_more: false,
            },
          }),
          stderr: "",
          exit_code: 0,
        };
      },
    });
    const chats = await client.listAllChats(10, ["p2p"]);
    assert.equal(calls.some((call) => call.command.includes("+search-user")), true);
    assert.deepEqual(chats, [
      {
        chat_id: "oc_bare",
        name: "Ben",
        chat_mode: "p2p",
        p2p_target_id: "ou_9",
      },
    ]);
    resetFeishuChatListCache();
    resetFeishuUserNameCache();
  });

  it("resolves sender names through contact +search-user", async () => {
    resetLarkCliProbeCache();
    resetFeishuUserNameCache();
    const calls = [];
    const client = new LarkCliClient({
      async spawn(input) {
        calls.push(input);
        return {
          stdout: JSON.stringify({
            ok: true,
            data: {
              users: [{ open_id: "ou_1", name: "Ada" }],
            },
          }),
          stderr: "",
          exit_code: 0,
        };
      },
    });
    const names = await client.resolveUserNames(["ou_1", "ou_1"]);
    assert.equal(calls[0].command.includes("+search-user"), true);
    assert.equal(names.get("ou_1"), "Ada");
    const again = await client.resolveUserNames(["ou_1"]);
    assert.equal(calls.length, 1);
    assert.equal(again.get("ou_1"), "Ada");
    assert.deepEqual(
      [...parseUserNamePage({ users: [{ open_id: "ou_2", localized_name: { zh_cn: "本" } }] })],
      [["ou_2", "本"]],
    );
    resetFeishuUserNameCache();
  });

  it("resolves sender names over HTTP when a user token is available", async () => {
    resetFeishuUserNameCache();
    const spawned = [];
    const fetched = [];
    const client = new LarkCliClient({
      async spawn(input) {
        spawned.push(input);
        throw new Error("CLI should not run when HTTP works");
      },
      userToken: {
        async token() {
          return "u-test";
        },
        async refresh() {},
        async identity() {
          return { app_id: "cli_1", user_open_id: "ou_me", brand: "feishu" };
        },
        async brand() {
          return "feishu";
        },
      },
      async fetch(url, init) {
        fetched.push({ url: String(url), init });
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({
              code: 0,
              data: {
                items: [
                  { open_id: "ou_1", name: "Ada" },
                  { open_id: "ou_2", nickname: "Ben" },
                ],
              },
            });
          },
          async json() {
            return JSON.parse(await this.text());
          },
        };
      },
    });
    const names = await client.resolveUserNames(["ou_2", "ou_1", "ou_1"]);
    assert.equal(spawned.length, 0);
    assert.equal(names.get("ou_1"), "Ada");
    assert.equal(names.get("ou_2"), "Ben");
    assert.match(fetched[0].url, /open\.feishu\.cn\/open-apis\/contact\/v3\/users\/batch/);
    assert.match(fetched[0].url, /user_ids=ou_1/);
    assert.match(fetched[0].url, /user_ids=ou_2/);
    assert.equal(fetched[0].init.headers.Authorization, "Bearer u-test");
    const again = await client.resolveUserNames(["ou_1", "ou_2"]);
    assert.equal(fetched.length, 1);
    assert.equal(again.get("ou_1"), "Ada");
    resetFeishuUserNameCache();
  });

  it("falls back to CLI for names the contact batch omits", async () => {
    resetFeishuUserNameCache();
    const spawned = [];
    const client = new LarkCliClient({
      async spawn(input) {
        spawned.push(input);
        return {
          stdout: JSON.stringify({
            ok: true,
            data: { users: [{ open_id: "ou_out", name: "Out of scope" }] },
          }),
          stderr: "",
          exit_code: 0,
        };
      },
      userToken: {
        async token() {
          return "u-test";
        },
        async refresh() {},
        async identity() {
          return { app_id: "cli_1", user_open_id: "ou_me", brand: "feishu" };
        },
        async brand() {
          return "feishu";
        },
      },
      async fetch() {
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({
              code: 0,
              data: { items: [{ open_id: "ou_in", name: "In scope" }] },
            });
          },
          async json() {
            return JSON.parse(await this.text());
          },
        };
      },
    });
    const names = await client.resolveUserNames(["ou_in", "ou_out"]);
    assert.equal(names.get("ou_in"), "In scope");
    assert.equal(names.get("ou_out"), "Out of scope");
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].command.includes("+search-user"), true);
    assert.equal(
      spawned[0].command[spawned[0].command.indexOf("--user-ids") + 1],
      "ou_out",
    );
    resetFeishuUserNameCache();
  });

  it("coalesces concurrent name lookups for the same ids", async () => {
    resetFeishuUserNameCache();
    let fetches = 0;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const client = new LarkCliClient({
      async spawn() {
        throw new Error("CLI should not run");
      },
      userToken: {
        async token() {
          return "u-test";
        },
        async refresh() {},
        async identity() {
          return { app_id: "cli_1", user_open_id: "ou_me", brand: "feishu" };
        },
        async brand() {
          return "feishu";
        },
      },
      async fetch() {
        fetches += 1;
        await gate;
        return {
          ok: true,
          status: 200,
          async text() {
            return JSON.stringify({
              code: 0,
              data: { items: [{ open_id: "ou_1", name: "Ada" }] },
            });
          },
          async json() {
            return JSON.parse(await this.text());
          },
        };
      },
    });
    const first = client.resolveUserNames(["ou_1"]);
    const second = client.resolveUserNames(["ou_1"]);
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(fetches, 1);
    assert.equal(a.get("ou_1"), "Ada");
    assert.equal(b.get("ou_1"), "Ada");
    resetFeishuUserNameCache();
  });

  it("sends text through the raw IM API", async () => {
    const calls = [];
    const client = new LarkCliClient({
      async spawn(input) {
        calls.push(input);
        return {
          stdout: JSON.stringify({
            ok: true,
            data: { message_id: "om_sent" },
          }),
          stderr: "",
          exit_code: 0,
        };
      },
    });

    const result = await client.sendText({
      chat_id: "oc_1",
      text: "hello",
      uuid: "uuid-1",
    });

    assert.equal(calls[0].command.includes("POST"), true);
    assert.equal(calls[0].command.includes("/open-apis/im/v1/messages"), true);
    const params = JSON.parse(calls[0].command[calls[0].command.indexOf("--params") + 1]);
    const data = JSON.parse(calls[0].command[calls[0].command.indexOf("--data") + 1]);
    assert.deepEqual(params, { receive_id_type: "chat_id" });
    assert.equal(data.receive_id, "oc_1");
    assert.equal(data.msg_type, "text");
    assert.equal(data.content, JSON.stringify({ text: "hello" }));
    assert.equal(data.uuid, "uuid-1");
    assert.equal(result.message_id, "om_sent");
  });

  it("uploads an image through im images create as the user", async () => {
    const calls = [];
    const client = new LarkCliClient({
      async spawn(input) {
        calls.push(input);
        return {
          stdout: JSON.stringify({
            ok: true,
            data: { image_key: "img_cli" },
          }),
          stderr: "",
          exit_code: 0,
        };
      },
    });
    const result = await client.uploadImage({
      filename: "shot.png",
      media_type: "image/png",
      bytes: new Uint8Array([9]),
    });
    assert.equal(result.image_key, "img_cli");
    assert.deepEqual(calls[0].command.slice(0, 5), [
      "lark-cli",
      "im",
      "images",
      "create",
      "--as",
    ]);
    assert.equal(calls[0].command[calls[0].command.indexOf("--as") + 1], "user");
    assert.equal(
      calls[0].command[calls[0].command.indexOf("--data") + 1],
      JSON.stringify({ image_type: "message" }),
    );
    assert.equal(calls[0].command[calls[0].command.indexOf("--file") + 1], "./shot.png");
    assert.equal(typeof calls[0].cwd, "string");
  });

  it("treats CLI ok:false and Feishu code!=0 as FeishuApiError", () => {
    assert.throws(
      () =>
        unwrapLarkCli({
          stdout: JSON.stringify({
            ok: false,
            error: { message: "not logged in", subtype: "auth" },
          }),
          stderr: "",
          exit_code: 1,
        }),
      (error) => error instanceof FeishuApiError && error.message === "not logged in",
    );
    assert.throws(
      () =>
        unwrapLarkCli({
          stdout: JSON.stringify({ code: 99991663, msg: "token invalid" }),
          stderr: "",
          exit_code: 0,
        }),
      (error) => error instanceof FeishuApiError && error.code === "99991663",
    );
  });

  it("parses a raw Feishu history page", () => {
    const page = parseHistoryPage({
      code: 0,
      data: {
        items: [
          {
            message_id: "om_1",
            msg_type: "text",
            create_time: "1723420800000",
            sender: { id: "ou_1", sender_type: "user" },
            body: { content: "{\"text\":\"hi\"}" },
            mentions: [
              { key: "@_user_1", id: "ou_2", name: "Ben", id_type: "open_id" },
            ],
          },
        ],
        has_more: false,
      },
    });
    assert.equal(page.items[0].sender.id, "ou_1");
    assert.deepEqual(page.items[0].mentions, [
      { key: "@_user_1", id: "ou_2", name: "Ben" },
    ]);
    assert.equal(page.has_more, false);
  });

  it("reads user identity from auth status JSON", () => {
    assert.equal(
      larkCliUserReady(JSON.stringify({ ok: true, identity: "user" }), 0),
      true,
    );
    assert.equal(
      larkCliUserReady(
        JSON.stringify({ ok: true, identities: { user: { userName: "Ada" } } }),
        0,
      ),
      true,
    );
    assert.equal(
      larkCliUserReady(JSON.stringify({ ok: true, identity: "bot" }), 0),
      false,
    );
    assert.equal(larkCliUserReady("{}", 1), false);
  });

  it("falls back to the global lark-cli command when an absolute path is missing", () => {
    assert.equal(resolveLarkCommand("/Users/missing/lark-cli"), "lark-cli");
    assert.equal(resolveLarkCommand("lark-cli"), "lark-cli");
  });

  it("loads every conversation page for the install picker, not just the latest 50", async () => {
    resetLarkCliProbeCache();
    resetFeishuChatListCache();
    const calls = [];
    const chats = await listFeishuCatalogChats({
      now: () => 1,
      async spawn(input) {
        calls.push(input.command.join(" "));
        if (input.command.includes("auth")) {
          return {
            stdout: JSON.stringify({ ok: true, identity: "user" }),
            stderr: "",
            exit_code: 0,
          };
        }
        const paramsIdx = input.command.indexOf("--params");
        let pageToken;
        if (paramsIdx >= 0) {
          const params = JSON.parse(input.command[paramsIdx + 1]);
          pageToken = params.page_token;
        }
        const cliPageTokenIdx = input.command.indexOf("--page-token");
        if (cliPageTokenIdx >= 0) {
          pageToken = input.command[cliPageTokenIdx + 1];
        }
        if (pageToken === "p2") {
          return {
            stdout: JSON.stringify({
              ok: true,
              data: {
                items: [
                  {
                    chat_id: "oc_partnership",
                    name: "合伙",
                    chat_mode: "group",
                    chat_status: "normal",
                  },
                ],
                has_more: false,
              },
            }),
            stderr: "",
            exit_code: 0,
          };
        }
        if (input.command.includes("+chat-list")) {
          return {
            stdout: JSON.stringify({
              ok: true,
              data: { chats: [], has_more: false },
            }),
            stderr: "",
            exit_code: 0,
          };
        }
        return {
          stdout: JSON.stringify({
            ok: true,
            data: {
              items: [
                {
                  chat_id: "oc_recent",
                  name: "最近的群",
                  chat_mode: "group",
                  chat_status: "normal",
                },
              ],
              has_more: true,
              page_token: "p2",
            },
          }),
          stderr: "",
          exit_code: 0,
        };
      },
    });
    assert.equal(
      calls.some((command) => command.includes("/open-apis/im/v1/chats")),
      true,
    );
    assert.deepEqual(
      chats.map((chat) => chat.name),
      ["最近的群", "合伙"],
    );
    resetLarkCliProbeCache();
    resetFeishuChatListCache();
  });

  it("returns the pages gathered before a catalog budget runs out", async () => {
    resetLarkCliProbeCache();
    resetFeishuChatListCache();
    const chats = await listFeishuCatalogChats({
      now: () => 1,
      budget_ms: 80,
      async spawn(input) {
        if (input.command.includes("auth")) {
          return {
            stdout: JSON.stringify({ ok: true, identity: "user" }),
            stderr: "",
            exit_code: 0,
          };
        }
        const paramsIdx = input.command.indexOf("--params");
        let pageToken;
        if (paramsIdx >= 0) {
          const params = JSON.parse(input.command[paramsIdx + 1]);
          pageToken = params.page_token;
        }
        if (pageToken === "p2") {
          await new Promise(() => {});
        }
        return {
          stdout: JSON.stringify({
            ok: true,
            data: {
              items: [
                {
                  chat_id: "oc_recent",
                  name: "最近的群",
                  chat_mode: "group",
                  chat_status: "normal",
                },
              ],
              has_more: true,
              page_token: "p2",
            },
          }),
          stderr: "",
          exit_code: 0,
        };
      },
    });
    assert.deepEqual(
      chats.map((chat) => chat.chat_id),
      ["oc_recent"],
    );
    resetLarkCliProbeCache();
    resetFeishuChatListCache();
  });

  it("distinguishes a missing CLI from a signed-out CLI", async () => {
    resetLarkCliProbeCache();
    const missing = await probeLarkCli({
      now: () => 1,
      async spawn() {
        throw new FeishuApiError("Unable to start lark-cli (is it on PATH?): spawn ENOENT");
      },
    });
    assert.deepEqual(missing, { installed: false, authenticated: false });
    assert.equal(larkCliCatalogHint(missing), "probe.notInstalled");

    resetLarkCliProbeCache();
    const signedOut = await probeLarkCli({
      now: () => 1,
      async spawn() {
        return {
          stdout: JSON.stringify({ ok: true, identity: "bot" }),
          stderr: "",
          exit_code: 0,
        };
      },
    });
    assert.deepEqual(signedOut, { installed: true, authenticated: false });
    assert.equal(larkCliCatalogHint(signedOut), "probe.notSignedIn");
    resetLarkCliProbeCache();
  });

  it("caches lark-cli auth probes for about 20 seconds", async () => {
    resetLarkCliProbeCache();
    let calls = 0;
    const spawn = async () => {
      calls += 1;
      return {
        stdout: JSON.stringify({ ok: true, identity: "user" }),
        stderr: "",
        exit_code: 0,
      };
    };
    assert.equal(await probeLarkCliAuth({ spawn, now: () => 1_000 }), true);
    assert.equal(await probeLarkCliAuth({ spawn, now: () => 15_000 }), true);
    assert.equal(calls, 1);
    assert.equal(await probeLarkCliAuth({ spawn, now: () => 22_000 }), true);
    assert.equal(calls, 2);
    resetLarkCliProbeCache();
  });
});

describe("appendFeishuOpenApiParams", () => {
  it("repeats array query keys for contact batch lookups", () => {
    const url = new URL("https://open.feishu.cn/open-apis/contact/v3/users/batch");
    appendFeishuOpenApiParams(url, {
      user_id_type: "open_id",
      user_ids: ["ou_1", "ou_2"],
    });
    assert.equal(url.searchParams.get("user_id_type"), "open_id");
    assert.deepEqual(url.searchParams.getAll("user_ids"), ["ou_1", "ou_2"]);
  });
});
