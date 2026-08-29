# 内置连接器

协议见[连接器](CONNECTOR.md)。本页是 Slack / DSH / 飞书 / Cursor 的实现笔记，不是内核分支规则。内置聊天 / Agent 渠道没有业务工单类型，省略 `subjectCatalog`。私有插件按申明式协议自己公布词表并盖 `unit_kind`。

- **English:** [../en/CONNECTOR_DRIVERS.md](../en/CONNECTOR_DRIVERS.md)
- **状态：** Phase 1

## 能力

| 驱动 | `source` | 同步 | 回复 | 新建 | 凭证 |
| --- | --- | --- | --- | --- | --- |
| `slack-channel` | `slack` | 一个频道 | 否 | 否 | `REGENIC_SLACK_TOKEN` |
| `dsh-session` web，无 `session_id` | `dsh` | 全部会话 | 是 | 是 | 主机要 token 时用 `REGENIC_DSH_TOKEN` |
| `dsh-session` web，有 `session_id` | `dsh` | 那一条 | 是 | 否 | 同上 |
| `dsh-session` cli | `dsh` | 一个 mailbox | 是 | 否 | 本机 `dsh` |
| `feishu-chat` | `feishu` | 勾选的会话，或当前能看到的全部群和/或单聊 | 是 | 否 | 本机 `lark-cli` 用户登录 |
| `cursor-agent` | `cursor` | 本机 SDK 会话 | 是 | 是 | 安装时粘贴或 `CURSOR_API_KEY` |

Slack 不实现 `createThread` / `bindEgress`。飞书不实现 `createThread`。未声明的方法不存在。DSH web 新建立刻 `session.create` 空会话，第一条用户文本走普通回复（`session.prompt` queue）；内核会等首次 poll。Cursor 声明 `create_with_task`：桌面先开本地草稿，第一条才 `Agent.create` + `send`；内核种出站、不等首次 poll。Cursor 密钥可在安装表单粘贴，只进本机钥匙串（或 `~/.regenic/credentials/cursor`），不进安装 config。

凭证引用：Slack 为 `env:REGENIC_SLACK_TOKEN`；DSH web 为 `env:REGENIC_DSH_TOKEN`（可空）；飞书为 `keychain:lark-cli`；Cursor 为 `keychain:regenic-cursor:<安装 id>` 或 `env:CURSOR_API_KEY`。`oauth:HANDLE` / `app:HANDLE` 已预留，本阶段内置驱动不用。

## kind 映射

DSH：

| 原生事件 | `kind` |
| --- | --- |
| `user/message` 且 `source.kind=user` | `user` |
| `assistant/message`（文本） | `assistant` |
| 插件注入的 `user/message` | `system` |

Slack 真人映射为 `user`。

Cursor 本机 Agent：

| 原生事件 | `kind` |
| --- | --- |
| 用户句 | `user`（出站，便于和本机回写对上） |
| 该 turn 的最终助手回复 | `assistant`（thinking / 中间进度句 / tool 丢弃） |
| 同一空隙里多出来的助手信封 | tombstone，只留最后一句 |
| Agent 仍在跑 | `thread_status` + `activity: working`（进行中的助手句不入库） |
| 其它节点 | 丢弃 |

Cursor：

线程 id：`cursor:<agent_id>`。只用官方 `@cursor/sdk` 在本机跑会话，形状对齐 [cursor/cookbook `sdk/coding-agent-cli`](https://github.com/cursor/cookbook/tree/main/sdk/coding-agent-cli)：Inbox 新建的第一条任务立刻 `Agent.create` + `send`，不进队列。后续回复只有 Agent 空闲时才 `Agent.resume` 再 `send`。两套时钟：**接单**是秒级——发给桌面的 HTTP 在 `create` / `resume` / `send()` 开工后就返回，不能干等 `run.wait()`，否则 Chromium 会超时并误报连不上本机服务。桌面 120 秒超时只覆盖这段开工（含冷启动 `resume`），不是整场任务。**完成**可以数小时：轮询用 `Agent.get` + `Agent.messages.list` 看 `thread_status` + `activity: working`，再等最终助手句。不要为了看进度去 `resume`，也不要对 ACTIVE / CREATING（含内存里还没 `wait()` 完的 live run）`force` 跟发。忙时的跟发写入 `~/.regenic/cursor-pending-sends.json`（文件里不放 API key），等观察到 IDLE 之后再每次只冲一条：poll 先组好本页（含上一轮 `ended`），或后台 `pumpRun` 结束。`Agent.get` / `list` 保持只读，避免观察时把状态机往前推。后台 `wait()` 只防泄漏，不是完成真相；sidecar 退出后再打开只 poll。点同步会扫本机 SDK 库存。消息时间按会话顺序用本次拉取时刻错开，不用 `Agent.createdAt`，避免后续回合挤到第一条旁边。不爬编辑器 Chat 历史，也不接 Cloud Agents。安装表单有 **默认模型**（SDK 必填，默认 `composer-2.5`）。能力按会话 Agent 声明：`await_reply`、`list_title: "prompt"`、`create_with_task`、`hold_while_working`。没有官方提问卡，所以不声明 `prompts`。测速用 `REGENIC_CURSOR_API_BASE`。

飞书：

| 原生消息 | `kind` |
| --- | --- |
| `sender_type=user`，`msg_type` 为 `text` / `post` / `image` / `file` / `audio` / `media` | `user` |
| `sender_type=app`（或 `bot`），同上 | `assistant` |
| 卡片和其他 `msg_type` | 丢弃 |

## 飞书

线程 id：`feishu:<chat_id>`。登录仍用 `lark-cli`。拉历史用进程内 HTTP，带钥匙串里的 `user_access_token`；读不到 token 再回退 `lark-cli api --as user`。图片和文件先走 `im/v1/messages/:id/resources/:file_key`；用户 token 的 HTTP 常常返回 JSON 而不是文件字节，这时回退到 `lark-cli im +messages-resources-download`。富文本 post 里的 `img` 一并收下。已同步过的会话会再倒序拉最近一页，补上以前丢掉的媒体；若当时只落下空占位（只能看见 `image.png` 文件名），再拉一次并用 `revise` 写入真实字节。Inbox 预览图片上限 8MB，`octet-stream` 也会按魔数认成 PNG/JPEG/GIF/WebP。新会话和还在从旧往新翻的会话，先倒序取最近一页，再排队回填更早的。每页最多 50 条。会话列表缓存约 30 秒。每条记录带上群名或单聊对方、`group` / `direct`、以及发送者姓名。群里 `@` 用消息自带的 `mentions[]` 写成可读人名；`@所有人` 也在这一步翻译。搜不到的发送者再走 `contact +search-user`。表单用 `lark-cli im +chat-list --types=p2p,group` 列出群和单聊，不收 token，也不用手贴 `oc_…`。默认两种都同步。安装后可以改范围。

## 安装前置

引擎页始终能打开安装弹层。必填前置未就绪时主按钮写「设置」，表单提交仍挡住。步骤写在 `installCatalog().setup_steps`，由用户做，内核只探测。

| 驱动 | `ready` 为 false 时 | 该跑什么 |
| --- | --- | --- |
| `slack-channel` | 未设 `REGENIC_SLACK_TOKEN` | 从 Slack 应用取 bot token，写入环境变量后重启桌面 |
| `dsh-session` web | PATH 上没有 `dsh` | 先让终端能跑 `dsh`，再 `dsh web --port 3080` |
| `dsh-session` web | 有 `dsh`，3080 没起来 | `dsh web --port 3080` |
| `dsh-session` cli | 本机 `dsh` | 终端能跑 `dsh` |
| `feishu-chat` | PATH 上没有 `lark-cli` | `npx @larksuite/cli@latest install`（[lark-cli](https://github.com/larksuite/cli)） |
| `feishu-chat` | 有 CLI，用户未登录 | `lark-cli config init`，然后 `lark-cli auth login --recommend` |
| `cursor-agent` | 没密钥 | 在安装表单粘贴 Cursor API key，或设 `CURSOR_API_KEY` |

飞书 token 留在系统钥匙串。二进制不在 PATH 上时，可用 `REGENIC_LARK_CLI`。
