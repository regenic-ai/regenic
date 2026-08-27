# 连接器

连接器是进程内插件。它读取一个来源；如果支持发送，就把回复写回同一个来源。

本文说明连接器 API。类型定义在 `@regenic/domain`。租约、隔离区、游标见[采集架构](INGESTION_ARCHITECTURE.md)。

本页给实现连接器的人看。

- **English:** [../en/CONNECTOR.md](../en/CONNECTOR.md)
- **相关：** [消息编排](MESSAGE_ORCHESTRATION.md) ·
  [执行器](EXECUTOR.md) ·
  [采集架构](INGESTION_ARCHITECTURE.md) · [技术栈](TECH_STACK.md) ·
  RFC 0004、0005、0006、0008、[0009](rfcs/0009-work-orchestration.md)
- **状态：** Phase 1

## 连接器是什么

连接器注册一个 `ChannelDriver`，带稳定的 `connector_type`，以及存在于
`CHANNELS` 里的 `source`（`dsh`、`slack`、`feishu` 等）。

Event、Blob、ACL、身份只能由采集服务写入。`ChannelConnector` 和
`EgressAdapter` 不写这些记录。

能力写在安装上。内核不按驱动名推断能力。

加来源不用改 API 或桌面。每个驱动自己声明 `installCatalog()`，以及可选的
`presentInstall` / `writeBackLabels`。引擎页由已注册驱动组装。额外包在
进程启动时由 `REGENIC_PLUGIN_DIR` 或 `REGENIC_CHANNEL_PLUGIN` 加载。
内核只对结果第一行与待办选项做精确匹配。

## 接口

| 接口 | 职责 |
| --- | --- |
| `ChannelDriver` | 安装、解析流、绑定发送、声明 `sync` / `reply` / `create`，以及 `installCatalog` / `presentInstall` / `writeBackLabels` |
| `ChannelConnector` | 把来源读成 `IngestBatch` |
| `EgressAdapter` | 把 `ContentPart[]` 写回同一来源 |

## 要求

每个连接器必须：

- 实现 `install()`。非法配置抛 `ChannelDriverError("invalid_config")`。
- 对该安装返回 `capabilities(installation)`。停用的安装把 `sync`、
  `reply`、`create` 都报 `false`。
- 用 `channelRecord()` 发记录。
- 在权威边界内使用确定的 `external_id`。控制台出站 id 含 `:out:`。
- 只有采集服务提交或隔离该页之后，才推进流游标。
- 从环境变量读凭证，或从一个指向环境变量的 `credentials_ref` 读。安装表单不收 token。
- 故障彼此隔离。一个安装不得拖住另一个。

不允许：

- 由连接器写 Event、Blob、Principal、ACL。
- 把 token 存进 `config`，或从 `/v1/me` 返回。
- 把未知的原生类型映射成 `message`。
- 把正文或密钥放进 `attrs`、日志或隔离区元数据。
- 在 API 或桌面按渠道名加开关。桌面读 `can_send`、`can_create`、`await_reply`、`list_title`、`surface.activity`，以及 inbox 上的 `prompts` / `unread` / `can_receipt` / `receipt`。

## 消息格式

连接器停在 L0：只翻译本渠道的 wire。交出去的是 L1 信封（`IngestRecord`：身份、时间、作者、正文、幂等）和 L2 封闭 `record_class`（`utterance` / `task` / `status` / `prompt`，由 `type` 映射）。L3 发言者只写在 `utterance` 上。L4 线程面由内核投影，L5 WorkItem 由策略开单，L6 执行器另挂。见[消息编排 · 分层](MESSAGE_ORCHESTRATION.md)与 [RFC 0009](rfcs/0009-work-orchestration.md)。不得在安装上标注「人聊 / Agent」。

| 名称 | 类型 | 说明 |
| --- | --- | --- |
| `source` | string | `CHANNELS` 里的渠道 id（`dsh`、`slack`、`feishu`） |
| `kind` | `user` \| `assistant` \| `system` | 从原生事件映射 |
| `direction` | `inbound` \| `outbound` | 读进来是 inbound。控制台回复是 outbound |
| `content` | `ContentPart[]` | `body`，外加可选的 `attachment` |
| `capabilities` | `{ sync, reply, create, await_reply?, list_title?, prompts?, attention?, receipts? }` | 由 `ChannelDriver.capabilities()` 返回 |

`channelRecord()` 把 surface（`channel`、`kind`、`direction`，以及可选的
`conversation_label` / `conversation_kind` / `actor_label` / `activity`）
附在记录上。`activity` 是渠道无关的线程状态：`working`（对端还在处理，
尚无可见正文）或 `awaiting_user`（对端在等用户在原渠道回答）。桌面只读
该字段，不按驱动名推断角色、方向或「是不是卡住了」。
`await_reply` 也由驱动声明：发送后若对端还会继续干活（会话 Agent），
设为 true；飞书这类聊天渠道不写。桌面只在 `await_reply` 为 true 且最近
一条是 outbound 时，才显示「已发送，等对端」。这不是第三条 `activity`，
只是对驱动声明的展示。
`list_title` 同样由驱动声明：聊天渠道设 `conversation`，列表标题用
`conversation_label`（群名、频道名、单聊对方）；会话 Agent 设 `prompt`，
列表标题用该会话第一条用户消息（跳过开头的 system 注入，找不到才回退到可见消息脸，避免退化成 session id）；不写则用可见消息脸。桌面不按渠道名分支。旧 Event 缺会话名时，驱动可实现
`resolveConversationLabels`，inbox 装饰层补上，不改历史正文。
`prompts` / `attention` / `receipts` 是另一条渠道无关的缝（Thread Surface）。两条已读面分开：`attention` 是「我有没有看对方」的会话未读（列表绿点，权威是本地 `last_read_*`）；`receipts` 是「对方有没有看我这条」的出站回执（气泡 Sent/Read，权威是连接器现查）。store 只存 Event 与 `last_read_*`；core 用最新 inbound 和游标算未读，并规范化答案形状；连接器只翻译本渠道控制面（mux / `read_status` / `read_users`），不得让内核认识 `om_` 或 `rpcId`。内核经 `installation + thread` 解析，桌面只读 inbox 上的 `prompts` / `unread` / `can_receipt` / `receipt`，不按 `dsh` / `feishu` 分支。Prompt 不入库为 Event；答题走 `POST /v1/me/conversations/prompts`，禁止再走 egress。已读本地游标在 `conversation_prefs.last_read_*`，这是 PC 已读权威；来源覆盖只能补未读，不能把本机没开过的会话消成已读。`receipts` 只在真实 API 存在时声明；飞书用户态 `read_users` 不得拿来当会话未读。详见 [RFC 0008](rfcs/0008-thread-surface.md)。

对端只有不可见劳动、且还没有可见回复时，连接器可另发一条
`type: "thread_status"` 记录（`activity: "working"`）。编排把它留在当前工作。
桌面用它做状态条，不画成聊天气泡，也不用它当会话标题。最后一条可见消息
已经是 Agent 回复时，不再挂「对端还在处理」——回复后面的工具/推理不算在等回复。
列表 `heads` 只露出该会话上一条可见消息（不必仍在当前工作），不附带
更新的 `working` 标记，也不水合全文。只有
`working`、没有任何可见消息的会话不进列表，避免标题退化成 session id。
过期的 `working` 也不再显示。

同一会话里，本地出站和渠道 history 回声的同一句话只保留一条 Event。

### 线程 id

格式：`source:target`。

例如：`dsh:<sessionId>`、`slack:C123`、`feishu:oc_…`。

`ChannelDriverRegistry` 用 `installation + thread` 解析。多条安装都能匹配时，
`ownsThread` 优先于第一条匹配。

## ChannelDriver

```ts
interface ChannelDriver {
  readonly connector_type: string;
  readonly source: string;
  install(input): NewConnectorInstallation;
  matchesThread(installation, thread): boolean;
  ownsThread(installation, thread): boolean;
  capabilities(installation): { sync; reply; create; await_reply?; list_title?; prompts?; attention?; receipts? };
  resolveConversationLabels?(installation, threads, env): Promise<Map<string, string>>;
  listPrompts?(installation, thread, host, env): Promise<ThreadPrompt[]>;
  answerPrompt?(installation, thread, answer, host, env): Promise<{ accepted: boolean }>;
  readAttention?(installation, threads, host, env): Promise<Map<string, ThreadAttention>>;
  ackAttention?(installation, thread, ack, host, env): Promise<void>;
  readReceipts?(installation, threads, host, env): Promise<Map<string, MessageReceipt>>;
  surfaceGeneration?(installation, host): string;
  canReply(installation): boolean;
  createThread(installation, host, env): Promise<ConversationThread>;
  resolveStreams(installation, host, env, options?): Promise<ConnectorStream[]>;
  resolveThreadStream(installation, thread, host, env): Promise<ConnectorStream>;
  bindEgress(installation, thread, host, env): Promise<RegisteredEgress>;
  outboundId(thread, receipt): string;
}
```

| 方法 | 说明 |
| --- | --- |
| `install` | 只持久化非密钥配置。Slack 必须有 `channel_id`。飞书存 `selection=all` 加 `kinds`（`group` / `p2p`，默认两个都开），或勾选的 `chat_ids`。`POST /v1/me/connectors/:id/config` 走同一套校验，改配置不丢游标。DSH web 可以不填 `session_id`（跟全部会话）。托管 API 忽略公网 DSH URL，改用 `REGENIC_DSH_BASE_URL`。 |
| `matchesThread` | 该安装能否处理这条线程。 |
| `ownsThread` | 该安装是否优先匹配。多条安装都能匹配时使用。 |
| `capabilities` | 该安装的 `sync` / `reply` / `create`，以及可选的 `await_reply`、`list_title`、`prompts`、`attention`、`receipts`。`await_reply`：DSH 为 true；飞书 / Slack 不写。`list_title`：飞书 / Slack 为 `conversation`；DSH 为 `prompt`（第一条用户消息）。`prompts`：DSH web 为 true，CLI 不写。`attention`：飞书为 true（来源 hint；本地游标所有渠道都有）。`receipts`：飞书为 true；DSH / Slack 不写。 |
| `resolveConversationLabels` | 可选。给缺 `conversation_label` 的旧线程补会话名。只读本地已有名字：飞书用安装里的 `chat_names`，Slack 用 `channel_name`。不得为了补名去 `listAllChats` 或挡住打开会话。 |
| `listPrompts` / `answerPrompt` | 可选。活的待决决策。DSH web 挂 mux，把 `question/requested` / `approval/requested` 映射成渠道无关 Prompt，答题走 `/api/respond`。`not-pending` 视为已解决。 |
| `readAttention` / `ackAttention` | 可选。来源已读覆盖（我看对方）。飞书对最新 inbound `om_` 调用户态 `read_status`；失败或官方已读都不消本机未读。ack 先写本地游标。 |
| `readReceipts` | 可选。对端是否已读我的出站。飞书对 `:out:om_` 调用户态 `read_users`。空 items 是 Sent。不得用来源会话未读。 |
| `surfaceGeneration` | 可选。活 surface 世代，拼进 `inbox_digest` 的 `&s=`，审批弹出时桌面轮询能看见。 |
| `canReply` | 与 `capabilities().reply` 相同。 |
| `resolveStreams` | 每个拉取单元一条 `ConnectorStream`。Slack：`channel:<id>`。飞书：勾选的 `chat:<id>`；`selection=all` 时只跟内核传入的 `options.threads`（当前工作 ∪ 打开中的会话）以及会话目录最近一页里新出现的 `chat_id`（约 2 分钟缓存）。不在这个集合里的流要卸掉。不得读 inbox，也不得每个 tick `listAllChats`。DSH web：每个会话 `session:<id>`。可选 `pace`：`idle_ms`（空转后隔多久再扫）、`catch_up_pages`（追历史一轮最多几页）。不写则每 tick 扫 1 页。内核只读声明，不按渠道名分支。 |
| `createThread` | `create` 为 true 时必须实现。否则抛 `unsupported_channel`。 |
| `bindEgress` | `reply` 为 true 时必须实现。否则抛 `unsupported_channel`。 |
| `outboundId` | 控制台发送的稳定 id。含 `:out:`。 |

`ChannelDriverError` 错误码：`invalid_config`、`missing_credentials`、
`sync_failed`、`send_failed`、`unsupported_channel`、`no_sender`。

```ts
interface ConnectorStreamPace {
  idle_ms?: number;
  catch_up_pages?: number;
}

interface ConnectorStream {
  stream_key: string;
  connector: Pick<ChannelConnector, "poll">;
  pace?: ConnectorStreamPace;
}
```

`pace` 由连接器按流声明。内核只读字段：有 `idle_ms` 且本 tick 空转后，后台 tick 可跳过该流。后台 tick 先给人让路：人在操作时只从内核算出的资格集合里扫少量会话的最近/新消息（每流 1 页），不追历史，也不枚举飞书全部会话。资格集合由内核从收件箱当前工作和打开中的会话算出，经 `options.threads` 传给驱动；新会话靠最近一页目录按 TTL 发现，不等人空闲。不在集合里的流卸掉。人空闲后再每次补 1 页历史。打开空会话先种最近一批；本地没有更早消息时，上翻再要 1 页更早的。人点 Engine Sync 时才按 `catch_up_pages`（内核封顶）往前赶。不写 `pace` 则每 tick 扫 1 页。飞书写 `{ idle_ms: 15_000, catch_up_pages: 5 }`；DSH / Slack 不写。

## ChannelConnector

轮询连接器实现 `poll`。Webhook、回填、成员同步在声明之前都可以不做。

```ts
poll(cursor: ConnectorCursor | null): Promise<PollResult>
```

`PollResult.batch` 是 `IngestBatch`（`schema_version: "1.0"`）。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `connector_id` | string | 安装 id |
| `org_id` | string | 权威边界 |
| `delivery_id` | string | 每一页唯一 |
| `records` | `IngestRecord[]` | 用 `channelRecord()` 构造 |
| `received_at` | string | ISO 时间 |
| `next_cursor` | string，可选 | 下一页位置 |

记录规则：

- 每个 content part 只能有 `bytes`、`text`、`external_locator` 之一。
- `external_locator` 由连接器自己拉取。核心不接收来源凭据。
- 来源私有字段放 `attrs`。不要放长正文或密钥。

## EgressAdapter

```ts
send(intent: SendIntent): Promise<DeliveryReceipt>
```

`SendIntent.content` 是 `ContentPart[]`（`body` 加附件）。适配器把这份信封写回同一来源和线程。

## 目录

`GET /v1/me/engine` 返回 catalog。引擎页在 Install 和 Edit sync 时用弹窗渲染这些字段。驱动只有声明 `installCatalog()` 才会出现；Slack、DSH、飞书和额外插件用同一个方法。桌面不按类型写死字段或标题。安装记录带 `settings`（非密钥配置的字符串形式），用来回填编辑表单。

| 字段 | 说明 |
| --- | --- |
| `fields` | `key`、`label`、是否必填、默认值、`visible_when`、可选 `multiple` + `options` |
| `prerequisites` | 环境变量或本机服务，带 `ready` 和 `hint` |
| `docs` | 研发规范。引擎页在「连接器」标题旁统一渲染一次，点开跳到 GitHub 网页 |

token 是前置条件，不是表单字段。内核不会替用户装 CLI 或起本机服务。
`ready` 为 false 时，`hint` 写出该跑的命令。飞书会分两档：没装二进制，
或装了但未登录。DSH 同样由连接器探测：`dsh web` 是否可达，以及 PATH 上
有没有 `dsh`。

监测写在驱动的 `probeCatalog()` 里。API 只合并各驱动的 `ready` / `hint` /
表单选项，桌面只渲染 catalog。加来源不用改 API 或桌面。

## 内置驱动

| 驱动 | `source` | 同步 | 回复 | 新建 | 凭证 |
| --- | --- | --- | --- | --- | --- |
| `slack-channel` | `slack` | 一个频道 | 否 | 否 | `REGENIC_SLACK_TOKEN` |
| `dsh-session` web，无 `session_id` | `dsh` | 全部会话 | 是 | 是 | 主机要 token 时用 `REGENIC_DSH_TOKEN` |
| `dsh-session` web，有 `session_id` | `dsh` | 那一条 | 是 | 否 | 同上 |
| `dsh-session` cli | `dsh` | 一个 mailbox | 是 | 否 | 本机 `dsh` |
| `feishu-chat` | `feishu` | 勾选的会话，或当前能看到的全部群和/或单聊 | 是 | 否 | 本机 `lark-cli` 用户登录 |

DSH `kind` 映射：

| 原生事件 | `kind` |
| --- | --- |
| `user/message` 且 `source.kind=user` | `user` |
| `assistant/message`（文本） | `assistant` |
| 插件注入的 `user/message` | `system` |

Slack 真人映射为 `user`。

飞书 `kind` 映射：

| 原生消息 | `kind` |
| --- | --- |
| `sender_type=user`，`msg_type` 为 `text` / `post` / `image` / `file` / `audio` / `media` | `user` |
| `sender_type=app`（或 `bot`），同上 | `assistant` |
| 卡片和其他 `msg_type` | 丢弃 |

线程 id：`feishu:<chat_id>`。登录仍用 `lark-cli`。拉历史用进程内 HTTP，带钥匙串里的 `user_access_token`；读不到 token 再回退 `lark-cli api --as user`。图片和文件先走 `im/v1/messages/:id/resources/:file_key`；用户 token 的 HTTP 常常返回 JSON 而不是文件字节，这时回退到 `lark-cli im +messages-resources-download`。富文本 post 里的 `img` 一并收下。已同步过的会话会再倒序拉最近一页，补上以前丢掉的媒体；若当时只落下空占位（只能看见 `image.png` 文件名），再拉一次并用 `revise` 写入真实字节。Inbox 预览图片上限 8MB，`octet-stream` 也会按魔数认成 PNG/JPEG/GIF/WebP。新会话和还在从旧往新翻的会话，先倒序取最近一页，再排队回填更早的。每页最多 50 条。会话列表缓存约 30 秒。每条记录带上群名或单聊对方、`group` / `direct`、以及发送者姓名。群里 `@` 用消息自带的 `mentions[]` 写成可读人名；`@所有人` 也在这一步翻译。搜不到的发送者再走 `contact +search-user`。表单用 `lark-cli im +chat-list --types=p2p,group` 列出群和单聊，不收 token，也不用手贴 `oc_…`。默认两种都同步。安装后可以改范围。

## 安装前置

引擎页在必填前置 `ready` 之前挡住 Install。步骤由用户做，内核只探测。

| 驱动 | `ready` 为 false 时 | 该跑什么 |
| --- | --- | --- |
| `slack-channel` | 未设 `REGENIC_SLACK_TOKEN` | 从 Slack 应用取 bot token，写入环境变量后重启桌面 |
| `dsh-session` web | PATH 上没有 `dsh` | 先让终端能跑 `dsh`，再 `dsh web --port 3080` |
| `dsh-session` web | 有 `dsh`，3080 没起来 | `dsh web --port 3080` |
| `dsh-session` cli | 本机 `dsh` | 终端能跑 `dsh` |
| `feishu-chat` | PATH 上没有 `lark-cli` | `npx @larksuite/cli@latest install`（[lark-cli](https://github.com/larksuite/cli)） |
| `feishu-chat` | 有 CLI，用户未登录 | `lark-cli config init`，然后 `lark-cli auth login --recommend` |

飞书 token 留在系统钥匙串。二进制不在 PATH 上时，可用 `REGENIC_LARK_CLI`。

## 范围外

- OAuth 安装
- 连接器市场
- Slack 回写
