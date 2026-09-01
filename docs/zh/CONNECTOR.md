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
`title`，最后是 `SOURCE`。这些 catalog 字段是 `CopyRef`，由 API 视图按
`GET /v1/me/engine?locale=` 或 `Accept-Language` 解析。内置 dsh / slack /
feishu 仍在 `CHANNELS` 里，给没有加载驱动的旧 Event 用。

Event、Blob、ACL、身份只能由采集服务写入。`ChannelConnector` 和
`EgressAdapter` 不写这些记录。

能力写在安装上。内核不按驱动名推断能力。

连接器是**申明式**插件，不是调度器。它声明能力、目录、词表和写回别名，
并把本渠道 wire 译成封闭字段。它不选 Recipe、不调执行器、不按业务类型
在插件里分支。内核只读声明：相等匹配、精确别名、catalog 渲染。加一种
任务类型 = 在 `subjectCatalog` 加一条并在入库时盖 `unit_kind`，不改内核
或桌面。

加来源不用改 API 或桌面。每个驱动自己声明 `installCatalog()`，以及可选的
`locales` / `presentInstall` / `writeBackLabels` / `subjectCatalog` /
`parseImport`。引擎页由已注册驱动组装。

随内核发布的包在 `package.json` 里声明 `regenic.plugin`、`id`、
`displayName`、`engines.regenic` 和 `contributes`。内核扫描自己的依赖，
只加载 `contributes.drivers` / `contributes.executors` 点名的导出，不再
扫 `Object.values`。额外包用同一份清单；缺 `contributes` 就是加载失败，
不会退回 duck-type。Nest 不 import 驱动符号。额外包仍由
`REGENIC_PLUGIN_DIR` 或 `REGENIC_CHANNEL_PLUGIN` 加载。启动后新出现的
extra 类型可以热发现（目录 watch，或 `POST /v1/me/plugins/reload`）。
`GET /v1/me/plugins` 和引擎页列出已加载、跳过和失败的包。额外包未签名，
与内核同进程运行。默认投放目录是 `~/.regenic/plugins`（`REGENIC_PLUGIN_DIR`
可覆盖），引擎页会显示这条路径。驱动拿到的是 `ConnectorHost`
（`connectors` / `egress` / `plugin` / `now` / `secrets`），没有
`authority` 或 `ingest`。`plugin()` 的 apply 也是同一套窄 `get`。catalog 里标了 `secret` 的字段写入钥匙串，落库
`config` 不留 token。四种最小形状在 `examples/connectors`。已注册的
`connector_type` 不会被替换；改已加载的包需要重启。内核只对结果第一行与待办选项做精确匹配。

## 端口

驱动只实现已声明的面。未声明的方法不存在；内核直接 501，驱动不必 stub。

| 端口 | 职责 | 何时实现 |
| --- | --- | --- |
| `ChannelDriverCore` | 安装、匹配线程、声明能力 | 每个驱动 |
| `ChannelSourcePort` | `resolveStreams` / `resolveThreadStream` + `poll` | `sync` 且 `source_mode` 为 poll / hybrid |
| Webhook | `bindWebhook` + `verifyWebhook` / `handleWebhook` | `source_mode` 为 webhook / hybrid |
| `ChannelSinkPort` | `bindEgress` / `outboundId` / 可选 `createThread` / 可选通用 egress 队列 | `reply`；`create` 另需 `createThread` |
| Catalog | `locales` / `installCatalog` / `presentInstall` / `probeCatalog` / `listCatalogFieldOptions` / `subjectCatalog` / 可选 `parseImport` | 要出现在引擎页；自带 UI 文案；表单下拉在打开安装弹层时加载；有工单类型时再声明词表；声明 `import_files` 时提供文件导入 |
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
  `oauth:HANDLE` / `app:HANDLE`。冒号后是句柄，不是 token。安装表单可以收
  `secret` 字段；内核写入钥匙串并从落库 `config` 删掉。驱动用
  `readInstallSecret` / `host.secrets` 读。环境变量仍走
  `readEnvCredential`。`oauth` / `app` 本阶段不解析。
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
  `quota`。内核不按来源名写限速常数。poll 先抢租约再扣配额；抢不到不扣。
  配额用尽放租约并返回 `throttled`，不当成拉取失败。
- 要出现在引擎页就实现 `installCatalog()`。可选 `presentInstall` 写已装
  行的文案。可选 `writeBackLabels` 列出回写时的精确别名。源系统把工作
  分成不同类型时，实现 `subjectCatalog()`，并在记录上盖 `unit_kind`。
  可选 `parseImport` 加上 `installCatalog().import_files` 会在该卡片上
  放文件选择。内核写 Event；驱动只返回 ingest batch。导入不必先安装。

不允许：

- 由连接器写 Event、Blob、Principal、ACL。
- 把 token 存进 `config`，或从 `/v1/me` 返回。
- 把未知的原生类型映射成 `message`。
- 把正文或密钥放进 `attrs`、日志或隔离区元数据。
- 在记录或安装上写 `recipe_id` / `executor_type`，或在插件里按任务类型
  选执行器。类型是声明，绑定是 Recipe。
- 在 API 或桌面按渠道名加开关。桌面读 `can_send`、`can_create`、`create_with_task`、`await_reply`、`hold_while_working`、`list_title`、`surface.activity`，以及 inbox 上的 `prompts` / `unread` / `can_receipt` / `receipt`。规则页的类型下拉只渲染 `subjectCatalog`。

## 隔离

连接器是进程内插件。内核用超时、`ConnectorHost`（没有 authority / ingest，包括 `plugin()` apply 里）和失败隔离，不默认出进程。

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
| `capabilities` | `{ sync, reply, create, await_reply?, list_title?, hydrate_on_open?, prompts?, attention?, receipts?, create_with_task?, hold_while_working? }` | 由 `ChannelDriver.capabilities()` 返回 |

`channelRecord()` 把 surface（`channel`、`kind`、`direction`，以及可选的
`conversation_label` / `conversation_kind` / `unit_kind` / `actor_label` /
`activity`）附在记录上。`conversation_kind` 是拓扑（`group` / `direct`），
只给人看。`unit_kind` 是工单类型，给 Recipe 相等匹配，不是对话名，也不
是 `record_class`。`activity` 是渠道无关的线程状态：`working`（对端还在
处理，尚无可见正文）或 `awaiting_user`（对端在等用户在原渠道回答）。桌面
只读该字段，不按驱动名推断角色、方向或「是不是卡住了」。
`await_reply` 也由驱动声明：发送后若对端还会继续干活（会话 Agent），
设为 true；飞书这类聊天渠道不写。桌面只在 `await_reply` 为 true 且最近
一条是 outbound 时，才显示「已发送，等对端」。这不是第三条 `activity`，
只是对驱动声明的展示。
`create_with_task`：创建会话必须带上第一条用户任务。桌面先开本地草稿；
`createThread` 收 `text` 并开工；内核种出站、不等首次 poll。不写则立刻建
空会话，第一条走普通回复（DSH）。
`hold_while_working`：`working` 期间的跟发由本连接器暂存，桌面可显示条数。
不写则跟发视为已送达（对端自己排队，DSH `session.prompt` queue）。
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

### 工单类型（`unit_kind`）

私有插件常把工作分成不同类型，并且**每个任务实例一条对话**。对话名
不稳定，不能当路由键。`record_class=task` 只说明「这是工单」，不能区分
「订单复审」和「线索跟进」。

连接器做三件申明式的事：

1. `subjectCatalog()` 公布词表。`id` 由连接器保证跨插件唯一（约定
   `{source}.{native}`，例如 `private.order_review`）。内核不解析点号。
2. 入库时用 `channelRecord({ unit_kind })` 盖章。类型从源 API / 表单 /
   管道读出。猜类型留在 L0。不要用对话名当类型，也不要把类型写进
   `conversation_kind`。同一任务实例的**每条**记录都盖同一 id；列表只拉
   heads（最后一条可见消息）。只盖首条，芯片会丢。
3. 安装表单若要限制同步范围，用 catalog `fields` 筛类型。那是「吃什么」，
   不是「怎么处理」。

内核只对 `Recipe.match.unit_kind` 做字符串相等。特异性：`thread_id` >
`unit_kind` > `source` > `record_class` > `thread_facet`。只写
`unit_kind` 就算具体。组织用 Recipe 绑执行器；`executor_config` 仍是
不透明袋。连接器禁止写 `recipe_id`。

聊天渠道没有业务类型就省略 `subjectCatalog`。源侧没有类型字段就不要盖章，
让粗 Recipe（`source` + `task`）兜底。

列表和线程头用 catalog 的 `label` 画类型芯片，不按渠道名分支。没有词条时
回退显示 `unit_kind` id。对话名仍然只做标题。本机回复和自动任务回写都会
把线程上已有的 `unit_kind` 抄到出站记录上，避免 heads 被盖掉。

## ChannelDriver

```ts
interface ChannelDriver extends ChannelDriverCore, ChannelSourcePort, Partial<ChannelSinkPort> {
  capabilities(installation): {
    sync; reply; create;
    await_reply?; list_title?; hydrate_on_open?;
    prompts?; attention?; receipts?;
    create_with_task?; hold_while_working?;
  };
  resolveConversationLabels?(installation, threads, env): Promise<Map<string, string>>;
  listPrompts?(installation, thread, host, env): Promise<ThreadPrompt[]>;
  answerPrompt?(installation, thread, answer, host, env): Promise<{ accepted: boolean }>;
  readAttention?(installation, threads, host, env): Promise<Map<string, ThreadAttention>>;
  ackAttention?(installation, thread, ack, host, env): Promise<void>;
  readReceipts?(installation, threads, host, env): Promise<Map<string, MessageReceipt>>;
  surfaceGeneration?(installation, host): string;
  locales?(): PluginLocaleTable[];
  installCatalog?(input?): DriverInstallCatalog;
  presentInstall?(installation, input?): { label: CopyRef; detail: CopyRef | null };
  writeBackLabels?(label): string[];
  subjectCatalog?(): { kinds: Array<{ id: string; label: CopyRef }> };
  probeCatalog?(input): Promise<ConnectorCatalogProbe>;
  listCatalogFieldOptions?(input): Promise<ConnectorCatalogProbe["field_options"]>;
}
```

| 方法 | 说明 |
| --- | --- |
| `install` | 只持久化非密钥配置。Slack 必须有 `channel_id`。飞书存 `selection=all` 加 `kinds`（`group` / `p2p`，默认两个都开），或勾选的 `chat_ids`。`POST /v1/me/connectors/:id/config` 走同一套校验，改配置不丢游标。DSH web 可以不填 `session_id`（跟全部会话）。托管 API 忽略公网 DSH URL，改用 `REGENIC_DSH_BASE_URL`。 |
| `matchesThread` | 该安装能否处理这条线程。 |
| `ownsThread` | 该安装是否优先匹配。多条安装都能匹配时使用。 |
| `capabilities` | 该安装的 `sync` / `reply` / `create`，以及可选的 `await_reply`、`list_title`、`hydrate_on_open`、`prompts`、`attention`、`receipts`、`create_with_task`、`hold_while_working`。`await_reply`：DSH / Cursor 为 true；飞书 / Slack 不写。`list_title`：飞书 / Slack 为 `conversation`；DSH / Cursor 为 `prompt`（第一条用户消息）。`hydrate_on_open`：打开会话时拉最近一页；飞书为 true。`prompts`：DSH web 为 true，CLI 不写。`attention`：飞书为 true（来源 hint；本地游标所有渠道都有）。`receipts`：飞书为 true；DSH / Slack / Cursor 不写。`create_with_task` / `hold_while_working`：Cursor 为 true；DSH 不写。 |
| `resolveConversationLabels` | 可选。给缺 `conversation_label` 的旧线程补会话名。只读本地已有名字：飞书用安装里的 `chat_names`，Slack 用 `channel_name`。不得为了补名去 `listAllChats` 或挡住打开会话。 |
| `listPrompts` / `answerPrompt` | 可选。活的待决决策。DSH web 挂 mux，把 `question/requested` / `approval/requested` 映射成渠道无关 Prompt，答题走 `/api/respond`。`not-pending` 视为已解决。 |
| `readAttention` / `ackAttention` | 可选。来源已读覆盖（我看对方）。飞书对最新 inbound `om_` 调用户态 `read_status`；失败或官方已读都不消本机未读。ack 先写本地游标。 |
| `readReceipts` | 可选。对端是否已读我的出站。飞书对 `:out:om_` 调用户态 `read_users`。空 items 是 Sent。不得用来源会话未读。 |
| `surfaceGeneration` | 可选。活 surface 世代，拼进 `inbox_digest` 的 `&s=`，审批弹出时桌面轮询能看见。 |
| `resolveStreams` | 每个拉取单元一条 `ConnectorStream`。Slack：`channel:<id>`。飞书：勾选的 `chat:<id>`；`selection=all` 时只跟内核传入的 `options.threads`（当前工作 ∪ 打开中的会话）以及会话目录最近一页里新出现的 `chat_id`（约 2 分钟缓存）。不在这个集合里的流要卸掉。不得读 inbox，也不得每个 tick `listAllChats`。DSH web：每个会话 `session:<id>`。可选 `pace`：`idle_ms`（空转后隔多久再扫）、`catch_up_pages`（追历史一轮最多几页）。不写则每 tick 扫 1 页。内核只读声明，不按渠道名分支。 |
| `createThread` | 可选。`create` 为 true 时必须实现。未声明则内核 501。声明了 `create_with_task` 时收 `options.text` 并开工；未声明则只建空会话，第一条用户文本走普通 send。 |
| `bindEgress` | 可选。`reply` 为 true 时必须实现。未声明则内核 501。 |
| `outboundId` | 控制台发送的稳定 id。含 `:out:`。 |
| `listEgressQueue` / `ackEgressQueue` | 可选。给无法在进程内写回渠道的适配器（本机浏览器扩展）排空队列。暴露为 `GET/POST /v1/me/connectors/:id/egress`，不是按渠道单独开的 API。 |
| `locales` | 可选。插件自带的英文（源）和中文表。第一方驱动必须实现，否则 catalog 会露出 key。 |
| `installCatalog` | 可选。引擎页卡片。不写则不出现。Slack、DSH、飞书和额外插件用同一个方法。文案字段是 `CopyRef`，不是已译句子。`setup_steps` 是弹层里的编号步骤；桌面渲染已经解析好的字符串。 |
| `presentInstall` | 可选。已装行的标题和细节（`CopyRef`）。 |
| `writeBackLabels` | 可选。某个待办选项的精确别名。内核只对结果第一行做匹配。 |
| `subjectCatalog` | 可选。工单类型词表。规则页按 `id` / `label` 渲染；内核只做相等匹配。不写则该来源没有类型维。 |
| `probeCatalog` | 可选。本机服务 / 环境是否就绪。不得在这里枚举来源资源（会话列表、agent 列表）。 |
| `listCatalogFieldOptions` | 可选。安装/编辑弹层的下拉选项。内核只在用户打开表单时调用，不在 `GET /v1/me/engine` 上调用。 |

`ChannelDriverError` 错误码：`invalid_config`、`missing_credentials`、
`sync_failed`、`send_failed`、`unsupported_channel`、`no_sender`、
`throttled`。

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

`GET /v1/me/engine` 返回 catalog。引擎页在 Install 和 Edit sync 时用弹窗渲染这些字段。未齐前置时主按钮写「设置」，仍打开同一张弹层。

驱动只有声明 `installCatalog()` 才会出现；Slack、DSH、飞书和额外插件用同一个方法。宿主不另写一份名单。`singleton: true` 只允许装一条。已装行的文案由 `presentInstall` 提供；不写则用 catalog 的 `instance_label` / `instance_detail_key`，再退到安装 id。桌面不按类型写死字段、标题或导入器。安装记录带 `settings`（非密钥配置的字符串形式），用来回填编辑表单。引擎 catalog 还会带上驱动的 `source` 和 `subjectCatalog` 词表，给规则页选 `unit_kind`。

catalog、展示、词表标签、探测 hint 和执行器调用字段返回 `CopyRef`：消息 id、`{ key, params }` 或 `{ literal }`。表里没有的裸字符串按原样显示（extra 和机器名）。`locales()` 是插件表。API 视图按 `GET /v1/me/engine?locale=` / `Accept-Language` 解析（收件箱、会话、执行器同样）。poll / ingest / send 永不收 locale。文档 URL 用 `href: string | { en, zh }`，不用 `_zh` 后缀。宿主不另维护一份翻译表。

额外包由 `REGENIC_PLUGIN_DIR`（每个带子 `package.json` 的子目录）或 `REGENIC_CHANNEL_PLUGIN`（一个模块 id 或路径）加载。每个额外包的 `package.json` 必须写 `regenic.contributes`。公开树不写私有包名。已注册的 `connector_type` 不会被额外包盖掉。启动后可以热发现新的 extra 类型；替换已加载的包仍需重启。显式插件缺失或无效时记入失败/跳过并打日志。`GET /v1/me/plugins` 返回这份库存。

工单写回时，内核把结果第一行与活的待办选项做精确匹配。`writeBackLabels(label)` 可给该选项加别名。宿主不维护同义列表。

| 字段 | 说明 |
| --- | --- |
| `fields` | `key`、`label`（`CopyRef`）、是否必填、默认值、`visible_when`、可选 `multiple` + `options` |
| `prerequisites` | 环境变量或本机服务，带 `ready` 和 `hint`（`CopyRef`） |
| `setup_steps` | 编号步骤：`title`（`CopyRef`），可选 `body` / `command` / `href` / `visible_when`。`href` 是 URL 或 `{ en, zh }`。弹层表单上方渲染；`command` 可复制。桌面不按渠道名写死步骤 |
| `import_files` | 引擎卡片上的文件选择：`accept`，可选 `max_bytes` / `title` / `description`（`CopyRef`）。需同时实现 `parseImport`。通用入口是 `POST /v1/me/imports` |
| `docs` | 研发规范。引擎页在「连接器」标题旁统一渲染一次，点开跳到 GitHub 网页。不当安装向导 |

token 是前置条件，不是表单字段。内核不会替用户装 CLI 或起本机服务。
`ready` 为 false 时，`hint` 写出该跑的命令。飞书会分两档：没装二进制，
或装了但未登录。DSH 同样由连接器探测：`dsh web` 是否可达，以及 PATH 上
有没有 `dsh`。

监测写在驱动的 `probeCatalog()` 里。API 把上次探测结果缓存后立刻返回引擎快照，不在这条请求上等待 CLI / 远端。表单选项走 `GET /v1/me/engine/catalog-options`。加来源不用改 API 或桌面。

内置 Slack / DSH / 飞书的能力表、kind 映射和安装前置见[内置驱动](CONNECTOR_DRIVERS.md)。

## 范围外

- OAuth 安装
- 连接器市场
- Slack 回写
- 出进程 / stdio 插件宿主
