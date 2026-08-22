# 连接器

连接器是进程内插件。它读取一个来源；如果支持发送，就把回复写回同一个来源。

本文说明连接器 API。类型定义在 `@regenic/domain`。租约、隔离区、游标见[采集架构](INGESTION_ARCHITECTURE.md)。

本页给实现连接器的人看。

- **English:** [../en/CONNECTOR.md](../en/CONNECTOR.md)
- **相关：** [消息编排](MESSAGE_ORCHESTRATION.md) ·
  [采集架构](INGESTION_ARCHITECTURE.md) · [技术栈](TECH_STACK.md) ·
  RFC 0004、0005、0006
- **状态：** Phase 1

## 连接器是什么

连接器注册一个 `ChannelDriver`，带稳定的 `connector_type`，以及存在于
`CHANNELS` 里的 `source`（`dsh`、`slack`、`feishu` 等）。

Event、Blob、ACL、身份只能由采集服务写入。`ChannelConnector` 和
`EgressAdapter` 不写这些记录。

能力写在安装上。内核不按驱动名推断能力。

加来源不用改 API 或桌面，加驱动和一条目录即可。

## 接口

| 接口 | 职责 |
| --- | --- |
| `ChannelDriver` | 安装、解析流、绑定发送、声明 `sync` / `reply` / `create` |
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
- 在 API 或桌面按渠道名加开关。桌面读 `can_send` 和 `can_create`。

## 消息格式

收发形状由 `@regenic/domain` 的 `message-contract` 定义。

| 名称 | 类型 | 说明 |
| --- | --- | --- |
| `source` | string | `CHANNELS` 里的渠道 id（`dsh`、`slack`、`feishu`） |
| `kind` | `user` \| `assistant` \| `system` | 从原生事件映射 |
| `direction` | `inbound` \| `outbound` | 读进来是 inbound。控制台回复是 outbound |
| `content` | `ContentPart[]` | `body`，外加可选的 `attachment` |
| `capabilities` | `{ sync, reply, create }` | 由 `ChannelDriver.capabilities()` 返回 |

`channelRecord()` 把 surface（`channel`、`kind`、`direction`）附在记录上。
桌面读这份元数据，不按驱动名推断角色或方向。

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
  capabilities(installation): { sync; reply; create };
  canReply(installation): boolean;
  createThread(installation, host, env): Promise<ConversationThread>;
  resolveStreams(installation, host, env): Promise<ConnectorStream[]>;
  resolveThreadStream(installation, thread, host, env): Promise<ConnectorStream>;
  bindEgress(installation, thread, host, env): Promise<RegisteredEgress>;
  outboundId(thread, receipt): string;
}
```

| 方法 | 说明 |
| --- | --- |
| `install` | 只持久化非密钥配置。Slack 必须有 `channel_id`。飞书必须有 `chat_id`。DSH web 可以不填 `session_id`（跟全部会话）。托管 API 忽略公网 DSH URL，改用 `REGENIC_DSH_BASE_URL`。 |
| `matchesThread` | 该安装能否处理这条线程。 |
| `ownsThread` | 该安装是否优先匹配。多条安装都能匹配时使用。 |
| `capabilities` | 该安装的 `sync` / `reply` / `create`。 |
| `canReply` | 与 `capabilities().reply` 相同。 |
| `resolveStreams` | 每个拉取单元一条 `ConnectorStream`。Slack：`channel:<id>`。飞书：`chat:<id>`。DSH web：每个会话 `session:<id>`。 |
| `createThread` | `create` 为 true 时必须实现。否则抛 `unsupported_channel`。 |
| `bindEgress` | `reply` 为 true 时必须实现。否则抛 `unsupported_channel`。 |
| `outboundId` | 控制台发送的稳定 id。含 `:out:`。 |

`ChannelDriverError` 错误码：`invalid_config`、`missing_credentials`、
`sync_failed`、`send_failed`、`unsupported_channel`、`no_sender`。

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

`GET /v1/me/engine` 返回 catalog。引擎页按它渲染安装表单。新连接器在那里加一条。桌面不按类型写死字段。

| 字段 | 说明 |
| --- | --- |
| `fields` | `key`、`label`、是否必填、默认值、`visible_when` |
| `prerequisites` | 环境变量或本机服务，带 `ready` |

token 是前置条件，不是表单字段。

## 内置驱动

| 驱动 | `source` | 同步 | 回复 | 新建 | 凭证 |
| --- | --- | --- | --- | --- | --- |
| `slack-channel` | `slack` | 一个频道 | 否 | 否 | `REGENIC_SLACK_TOKEN` |
| `dsh-session` web，无 `session_id` | `dsh` | 全部会话 | 是 | 是 | 主机要 token 时用 `REGENIC_DSH_TOKEN` |
| `dsh-session` web，有 `session_id` | `dsh` | 那一条 | 是 | 否 | 同上 |
| `dsh-session` cli | `dsh` | 一个 mailbox | 是 | 否 | 本机 `dsh` |
| `feishu-chat` | `feishu` | 一个群 | 是 | 否 | 本机 `lark-cli` 用户登录 |

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
| `sender_type=user`，`msg_type` 为 `text` 或 `post` | `user` |
| `sender_type=app`（或 `bot`），`msg_type` 为 `text` 或 `post` | `assistant` |
| 图片、文件、卡片和其他 `msg_type` | 丢弃 |

线程 id：`feishu:<chat_id>`。历史用 `lark-cli api --as user`。安装表单不收 token。

## 范围外

- OAuth 安装
- 连接器市场
- Slack 回写
