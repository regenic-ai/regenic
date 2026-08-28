# 连接器

连接器是进程内插件。它读取一个来源；如果支持发送，就把回复写回同一个来源。

本文说明连接器 API。类型定义在 `@regenic/domain`。租约、隔离区、游标见[采集架构](INGESTION_ARCHITECTURE.md)。

本页给实现连接器的人看。

- **English:** [../en/CONNECTOR.md](../en/CONNECTOR.md)
- **相关：** [内置驱动](CONNECTOR_DRIVERS.md) · [消息编排](MESSAGE_ORCHESTRATION.md) ·
  [执行器](EXECUTOR.md) ·
  [采集架构](INGESTION_ARCHITECTURE.md) · [技术栈](TECH_STACK.md) ·
  RFC 0004、0005、0006、0008、[0009](rfcs/0009-work-orchestration.md)
- **状态：** Phase 1

## 连接器是什么

连接器注册一个 `ChannelDriver`，带稳定的 `connector_type` 和 `source`。
`source` 由驱动声明，不必事先写进 `CHANNELS`。展示名来自
`installCatalog().channel_label`；没有则回退 `CHANNELS`，再回退 catalog
`title`，最后是 `SOURCE`。内置 dsh / slack / feishu 仍在 `CHANNELS` 里，给没有
加载驱动的旧 Event 用。

Event、Blob、ACL、身份只能由采集服务写入。`ChannelConnector` 和
`EgressAdapter` 不写这些记录。

能力写在安装上。内核不按驱动名推断能力。

加来源不用改 API 或桌面。每个驱动自己声明 `installCatalog()`，以及可选的
`presentInstall` / `writeBackLabels`。引擎页由已注册驱动组装。额外包在
进程启动时由 `REGENIC_PLUGIN_DIR` 或 `REGENIC_CHANNEL_PLUGIN` 加载。
内核只对结果第一行与待办选项做精确匹配。

## 端口

驱动只实现已声明的面。未声明的方法不存在；内核直接 501，驱动不必 stub。

| 端口 | 职责 | 何时实现 |
| --- | --- | --- |
| `ChannelDriverCore` | 安装、匹配线程、声明能力 | 每个驱动 |
| `ChannelSourcePort` | `resolveStreams` / `resolveThreadStream` + `poll` | `sync` 且 `source_mode` 为 poll / hybrid |
| Webhook | `bindWebhook` + `verifyWebhook` / `handleWebhook` | `source_mode` 为 webhook / hybrid |
| `ChannelSinkPort` | `bindEgress` / `outboundId` / 可选 `createThread` | `reply`；`create` 另需 `createThread` |
| Catalog | `installCatalog` / `presentInstall` / `probeCatalog` | 要出现在引擎页 |
| Surface | `prompts` / `attention` / `receipts` | 对应能力旗标为 true |
| `EgressAdapter` | 把 `ContentPart[]` 写回同一来源 | 实现了 `bindEgress` |

## 要求

每个连接器必须：

- 实现 `install()`。非法配置抛 `ChannelDriverError("invalid_config")`。
- 对该安装返回 `capabilities(installation)`。停用的安装把 `sync`、
  `reply`、`create` 都报 `false`。`reply` 必须带 `bindEgress` 与
  `outboundId`；`create` 必须带 `createThread`。内核读声明，不读
  `canReply`。符合性由 `verifyChannelDriverConformance` /
  `verifyPollConnectorConformance` 验收。
- 用 `channelRecord()` 发记录。
- 在权威边界内使用确定的 `external_id`。控制台出站 id 含 `:out:`。
- 只有采集服务提交或隔离该页之后，才推进流游标。
- 凭证走 `credentials_ref`：`env:NAME`、`keychain:SERVICE`，以及预留的
  `oauth:HANDLE` / `app:HANDLE`。冒号后是句柄，不是 token。安装表单不收
  密钥。内核用 `readEnvCredential` 读环境变量；钥匙串由连接器自己读。
  `oauth` / `app` 本阶段不解析，等第二个官方来源再做刷新。
- 插件可声明 `connector_protocol`。省略视为 `1.0`。内核跳过不支持的版本。
- 故障彼此隔离。一个安装不得拖住另一个。tick 并行拉各启用安装；单次
  `poll` 和整次 tick/catch-up sync 有截止时间，超时释放租约。
- 声明 `source_mode`。省略为 poll。`webhook` / `hybrid` 必须实现
  `verifyWebhook` + `handleWebhook`，以及驱动上的 `bindWebhook`。
  webhook-only 不得声明 `poll`；tick 不拉它。Webhook 校验与翻译之后仍走
  采集，连接器不写 Event。
- 安装级配额是 token bucket，默认 60 次 / 60s
  （`REGENIC_CONNECTOR_QUOTA_TOKENS` /
  `REGENIC_CONNECTOR_QUOTA_WINDOW_MS`）。`0` 关闭。连接器可自报更紧的
  `quota`。内核不按来源名写限速常数。配额用尽返回 `throttled`，不当成
  拉取失败。
- 要出现在引擎页就实现 `installCatalog()`。可选 `presentInstall` 写已装
  行的文案。可选 `writeBackLabels` 列出回写时的精确别名。

不允许：

- 由连接器写 Event、Blob、Principal、ACL。
- 把 token 存进 `config`，或从 `/v1/me` 返回。
- 把未知的原生类型映射成 `message`。
- 把正文或密钥放进 `attrs`、日志或隔离区元数据。
- 在 API 或桌面按渠道名加开关。桌面读 `can_send`、`can_create`、`await_reply`、`list_title`、`surface.activity`，以及 inbox 上的 `prompts` / `unread` / `can_receipt` / `receipt`。

## 隔离

连接器是进程内插件。内核用超时和失败隔离，不默认出进程。

- tick 并行拉各启用安装。一处抛错或超时不挡其它安装；该安装仍在
  `inflight` 时，下一 tick 跳过它。
- `ConnectorRunner.poll` 对 `connector.poll` 施加截止时间。超时释放租约，
  游标不推进。`source_mode` 为 webhook 时不调用 `poll`。
- `ConnectorRunner.webhook` 先 `verifyWebhook` 再 `handleWebhook`，再交给
  采集。不占 poll 租约，不推进 poll 游标。入口是
  `POST /v1/me/connectors/:id/webhook`。
- 默认：poll 20s（`REGENIC_CONNECTOR_POLL_TIMEOUT_MS`），tick / catch-up
  的整次 sync 30s（`REGENIC_CONNECTOR_SYNC_TIMEOUT_MS`）。设为 `0` 关闭
  超时。
- 每个安装一个 token bucket。默认 60 / 60s；连接器可声明 `quota`。内核不
  为 Slack / 飞书 / 钉钉各写一套常数。
- `probeCatalog`、inbox 回执和会话名查找已经按驱动吞掉失败。
- stdio 出进程宿主留给不可信第三方插件，不在本阶段。

## 消息格式

连接器停在 L0：只翻译本渠道的 wire。交出去的是 L1 信封（`IngestRecord`：身份、时间、作者、正文、幂等）和 L2 封闭 `record_class`（`utterance` / `task` / `status` / `prompt`，由 `type` 映射）。L3 发言者只写在 `utterance` 上。L4 线程面由内核投影，L5 WorkItem 由策略开单，L6 执行器另挂。见[消息编排 · 分层](MESSAGE_ORCHESTRATION.md)与 [RFC 0009](rfcs/0009-work-orchestration.md)。不得在安装上标注「人聊 / Agent」。

| 名称 | 类型 | 说明 |
| --- | --- | --- |
| `source` | string | 驱动声明的渠道 id。展示名走 catalog，不要求先登记 `CHANNELS` |
| `kind` | `user` \| `assistant` \| `system` | 从原生事件映射 |
| `direction` | `inbound` \| `outbound` | 读进来是 inbound。控制台回复是 outbound |
| `content` | `ContentPart[]` | `body`，外加可选的 `attachment` |
| `capabilities` | `{ sync, reply, create, await_reply?, list_title?, hydrate_on_open?, prompts?, attention?, receipts? }` | 由 `ChannelDriver.capabilities()` 返回 |

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
interface ChannelDriver extends ChannelDriverCore, ChannelSourcePort, Partial<ChannelSinkPort> {
  capabilities(installation): {
    sync; reply; create;
    await_reply?; list_title?; hydrate_on_open?;
    prompts?; attention?; receipts?;
  };
  resolveConversationLabels?(installation, threads, env): Promise<Map<string, string>>;
  listPrompts?(installation, thread, host, env): Promise<ThreadPrompt[]>;
  answerPrompt?(installation, thread, answer, host, env): Promise<{ accepted: boolean }>;
  readAttention?(installation, threads, host, env): Promise<Map<string, ThreadAttention>>;
  ackAttention?(installation, thread, ack, host, env): Promise<void>;
  readReceipts?(installation, threads, host, env): Promise<Map<string, MessageReceipt>>;
  surfaceGeneration?(installation, host): string;
  installCatalog?(input?): DriverInstallCatalog;
  presentInstall?(installation, input?): { label; detail };
  writeBackLabels?(label): string[];
  probeCatalog?(input): Promise<ConnectorCatalogProbe>;
}
```

| 方法 | 说明 |
| --- | --- |
| `install` | 只持久化非密钥配置。Slack 必须有 `channel_id`。飞书存 `selection=all` 加 `kinds`（`group` / `p2p`，默认两个都开），或勾选的 `chat_ids`。`POST /v1/me/connectors/:id/config` 走同一套校验，改配置不丢游标。DSH web 可以不填 `session_id`（跟全部会话）。托管 API 忽略公网 DSH URL，改用 `REGENIC_DSH_BASE_URL`。 |
| `matchesThread` | 该安装能否处理这条线程。 |
| `ownsThread` | 该安装是否优先匹配。多条安装都能匹配时使用。 |
| `capabilities` | 该安装的 `sync` / `reply` / `create`，以及可选的 `await_reply`、`list_title`、`hydrate_on_open`、`prompts`、`attention`、`receipts`。`await_reply`：DSH 为 true；飞书 / Slack 不写。`list_title`：飞书 / Slack 为 `conversation`；DSH 为 `prompt`（第一条用户消息）。`hydrate_on_open`：打开会话时拉最近一页；飞书为 true。`prompts`：DSH web 为 true，CLI 不写。`attention`：飞书为 true（来源 hint；本地游标所有渠道都有）。`receipts`：飞书为 true；DSH / Slack 不写。 |
| `resolveConversationLabels` | 可选。给缺 `conversation_label` 的旧线程补会话名。只读本地已有名字：飞书用安装里的 `chat_names`，Slack 用 `channel_name`。不得为了补名去 `listAllChats` 或挡住打开会话。 |
| `listPrompts` / `answerPrompt` | 可选。活的待决决策。DSH web 挂 mux，把 `question/requested` / `approval/requested` 映射成渠道无关 Prompt，答题走 `/api/respond`。`not-pending` 视为已解决。 |
| `readAttention` / `ackAttention` | 可选。来源已读覆盖（我看对方）。飞书对最新 inbound `om_` 调用户态 `read_status`；失败或官方已读都不消本机未读。ack 先写本地游标。 |
| `readReceipts` | 可选。对端是否已读我的出站。飞书对 `:out:om_` 调用户态 `read_users`。空 items 是 Sent。不得用来源会话未读。 |
| `surfaceGeneration` | 可选。活 surface 世代，拼进 `inbox_digest` 的 `&s=`，审批弹出时桌面轮询能看见。 |
| `resolveStreams` | 每个拉取单元一条 `ConnectorStream`。Slack：`channel:<id>`。飞书：勾选的 `chat:<id>`；`selection=all` 时只跟内核传入的 `options.threads`（当前工作 ∪ 打开中的会话）以及会话目录最近一页里新出现的 `chat_id`（约 2 分钟缓存）。不在这个集合里的流要卸掉。不得读 inbox，也不得每个 tick `listAllChats`。DSH web：每个会话 `session:<id>`。可选 `pace`：`idle_ms`（空转后隔多久再扫）、`catch_up_pages`（追历史一轮最多几页）。不写则每 tick 扫 1 页。内核只读声明，不按渠道名分支。 |
| `createThread` | 可选。`create` 为 true 时必须实现。未声明则内核 501。 |
| `bindEgress` | 可选。`reply` 为 true 时必须实现。未声明则内核 501。 |
| `outboundId` | 控制台发送的稳定 id。含 `:out:`。 |
| `installCatalog` | 可选。引擎页卡片。不写则不出现。Slack、DSH、飞书和额外插件用同一个方法。 |
| `presentInstall` | 可选。已装行的标题和细节。 |
| `writeBackLabels` | 可选。某个待办选项的精确别名。内核只对结果第一行做匹配。 |
| `probeCatalog` | 可选。本机服务 / 环境是否就绪，以及表单选项。 |

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

运行时按 `source_mode` 调用方法。省略即为 poll。Webhook、回填、成员同步
未声明则方法不存在，内核不会调用。符合性由
`verifyConnectorSourceMode` 验收。

```ts
interface ChannelConnector {
  readonly source: string;
  readonly source_mode?: "poll" | "webhook" | "hybrid";
  readonly quota?: { tokens: number; window_ms: number };
  poll?(cursor: ConnectorCursor | null, options?: ConnectorPollOptions): Promise<PollResult>;
  capabilities?(): ConnectorCapabilities;
  verifyWebhook?(request): Promise<VerifiedWebhook>;
  handleWebhook?(webhook): Promise<IngestBatch>;
  backfill?(range): AsyncIterable<IngestBatch>;
  syncMembers?(scope): Promise<MembershipBatch>;
}
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

`GET /v1/me/engine` 返回 catalog。引擎页在 Install 和 Edit sync 时用弹窗渲染这些字段。

驱动只有声明 `installCatalog()` 才会出现；Slack、DSH、飞书和额外插件用同一个方法。宿主不另写一份名单。`singleton: true` 只允许装一条。已装行的文案由 `presentInstall` 提供；不写则用 catalog 的 `instance_label` / `instance_detail_key`，再退到安装 id。桌面不按类型写死字段或标题。安装记录带 `settings`（非密钥配置的字符串形式），用来回填编辑表单。

额外包在进程启动时加载一次：`REGENIC_PLUGIN_DIR`（每个带子 `package.json` 的子目录）或 `REGENIC_CHANNEL_PLUGIN`（一个模块 id 或路径）。`REGENIC_CRM_CONNECTOR` 是后者的兼容别名。公开树不写私有包名。已注册的 `connector_type` 不会被额外包盖掉。显式插件缺失或无效时跳过并打日志。

工单写回时，内核把结果第一行与活的待办选项做精确匹配。`writeBackLabels(label)` 可给该选项加别名。宿主不维护同义列表。

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

内置 Slack / DSH / 飞书的能力表、kind 映射和安装前置见[内置驱动](CONNECTOR_DRIVERS.md)。

## 范围外

- OAuth 安装
- 连接器市场
- Slack 回写
- 出进程 / stdio 插件宿主
