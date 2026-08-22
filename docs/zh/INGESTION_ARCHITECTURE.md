# 采集架构

- **English:** [../en/INGESTION_ARCHITECTURE.md](../en/INGESTION_ARCHITECTURE.md)
- **状态：** Phase 1 实现架构
- **相关：** RFC 0005、RFC 0006、RFC 0007、[连接器](CONNECTOR.md)、[技术栈](TECH_STACK.md) 与[消息编排](MESSAGE_ORCHESTRATION.md)

## 1. 目的

Phase 1 是面向单人的本地优先采集基础。原生输入和连接器被译成 `IngestBatch`，并持久化为符合 RFC 形状的 Blob 与 Event。组织层随后使用同一份契约，不替换个人采集管线。

连接器是[消息编排](MESSAGE_ORCHESTRATION.md)的接收半边。发送（`EgressAdapter`）更晚，不属于本采集核心。

设计规则：

> 适配器只翻译。采集核心负责校验、鉴权、去重、存储与审计。

连接器不得直接写入 Event、Blob、身份或访问策略记录。来源特有行为留在产品不变量之外，因此增加新来源时，无需复制边界、存储或可靠性逻辑。

对协作来源，Agent 回合是带 provenance 的来源记录，不是权威事实。详见[协作平台集成架构](CONTEXT_PLATFORM_INTEGRATION.md)。

## 2. 范围

### 2.1 目标

- 通过同一条管线支持原生 API 输入、webhook、轮询与回填。
- 保留来源身份、时间戳、作者、线程结构、出处与访问域。
- 通过 `BlobStore` 端口存储内容，通过 `AuthorityStore` 保存轻量 Event 元数据。
- 通过确定性幂等使重试安全。
- 处理编辑、撤回、删除、部分批次与乱序投递。
- 个人阶段强制本地主体边界；组织阶段身份或 ACL 映射未解析时，按拒绝优先原则处理。
- 隔离连接器故障，并对每个连接器独立施加背压。
- 产出可审计、可供后续蒸馏使用的 Event 记录。
- 通过稳定端口保持连接器与存储实现可替换。

### 2.2 范围外

- Digest 生成或日蒸馏。
- Claim 抽取、上下文 Snapshot 或知识图谱构建。
- LLM 调用、Embedding 或语义搜索。
- Standard 生命周期实现。
- 连接器市场。
- 显式外部身份映射之外的跨来源实体消歧。
- 第三方系统的恰好一次投递。Regenic 保证的是幂等效果。

## 3. 不变量

1. 每条被接受的来源记录都经过同一个采集应用服务。
2. 每个 Event 都属于一个权威边界：个人阶段是本地主体，组织阶段是组织与 ACL scope。
3. 组织 ACL 映射缺失或有歧义时，绝不默认组织级可见。
4. Blob 字节不存在独立读取路径。读取必须通过引用它的 Event 鉴权。
5. 除 RFC 限定的预览外，Event 正文不存放在 `AuthorityStore` 中。
6. `(org_id, source, external_id)` 标识一次来源事件，并且幂等。
7. 只有当前游标之前的记录全部提交或持久化进入隔离区后，连接器游标才能推进。
8. 来源重试可以重复工作，但不能产生重复效果。
9. 连接器代码不能扩大权限、创建特权 Principal 或绕过校验。
10. 采集后的处理从已提交的持久任务记录开始，而不是从未提交状态开始。个人阶段可在进程内处理；组织阶段可通过 outbox 发布到 BullMQ。
11. 存储统一使用 UTC。有价值的来源时区和原始时间戳表示保留在元数据中。
12. 默认情况下，来源原始 payload 在规范化后不再保留。

## 4. 上下文图

```text
原生客户端                       外部系统
    |                         webhook | poll | backfill
    |                                  |
    v                                  v
原生适配器                    ChannelConnector 驱动
    |                                  |
    +------------ IngestBatch ---------+
                         |
                         v
                    采集服务
             校验 | 映射 | 鉴权
             规范化 | 哈希 | 去重
                         |
               +---------+----------+
               |                    |
               v                    v
          BlobStore 端口         AuthorityStore 端口
          规范化字节             Event 元数据
                     边界 / 策略引用
                     游标 / 隔离区
                     持久任务记录
                                      |
                                      v
                      JobQueue 端口
                          后续索引 | 蒸馏 | 通知
```

## 5. 组件

### 5.1 ChannelConnector

驱动负责理解一种来源协议。它可以校验签名、调用来源 API、规范化记录并报告能力，但不负责持久化或鉴权决策。实现规则见[连接器](CONNECTOR.md)。

```ts
interface ChannelConnector {
  readonly source: string;

  capabilities(): ConnectorCapabilities;
  verifyWebhook(request: WebhookRequest): Promise<VerifiedWebhook>;
  handleWebhook(webhook: VerifiedWebhook): Promise<IngestBatch>;
  poll(cursor: ConnectorCursor | null): Promise<PollResult>;
  backfill(range: BackfillRange): AsyncIterable<IngestBatch>;
  syncMembers(scope: ExternalScopeRef): Promise<MembershipBatch>;
}

interface ConnectorCapabilities {
  webhook: boolean;
  poll: boolean;
  backfill: boolean;
  member_sync: boolean;
  edits: boolean;
  tombstones: boolean;
  attachments: boolean;
}
```

连接器显式报告能力。编排器不能根据驱动名称猜测其行为。

### 5.2 连接器编排器

编排器运行 webhook、轮询、回填，以及组织阶段的成员同步工作流。它负责调度、游标推进、限流、重试策略和队列隔离。每个连接器安装实例拥有独立逻辑队列和并发限制。个人阶段使用进程内 `JobQueue` 驱动；组织阶段可使用 BullMQ。

### 5.3 采集服务

采集服务是唯一允许创建或变更 Event 的应用边界。它负责：

- schema 与连接器安装配置校验；
- 权威边界检查；
- 外部 Principal 与 scope 解析；
- 规范内容生成；
- 内容哈希与 Blob 写入；
- Event 幂等与 revision 处理；
- tombstone 与隔离区决策；
- 接受后由内核写入 disposition（过滤 / 分层）；Event 仍作为证据留下；
- 审计记录与持久化采集后任务创建。

### 5.4 边界解析器

个人阶段将导入记录映射到唯一的本地主体，并把外部 actor 记录为出处。连接器不能逃逸出本地权威边界。

组织阶段的身份与 scope 解析器将 `ExternalPrincipalRef` 和 `ExternalScopeRef` 映射为 RFC 0006 Principal 与 ACL scope。无法解析的身份或 scope 进入隔离区，绝不能为方便而回退到 org scope。

### 5.5 内容规范化器

规范化按媒体类型和 schema 版本选择，而不是按连接器选择。它在计算哈希前生成稳定字节。

- 文本使用 UTF-8 和统一换行符，不包含传输包装。
- JSON 使用已定义的 schema 投影和确定性键排序。
- 文件保留原始字节，元数据单独存储。
- 富文本将来源表示保留为 Blob；纯文本投影是独立派生物。

规范化不得静默移除有意义的内容。有损投影不能替代来源 Blob。

### 5.6 BlobStore

RFC 端口保持最小化：

```ts
interface BlobStore {
  put(hash: string, bytes: Uint8Array, mediaType: string): Promise<void>;
  get(hash: string): Promise<Uint8Array>;
  delete(hash: string): Promise<void>;
  exists(hash: string): Promise<boolean>;
}
```

对于相同字节，`put` 必须幂等。哈希由采集服务计算，不能信任驱动提供的哈希。

### 5.7 AuthorityStore

`AuthorityStore` 是关系型权威存储端口。个人阶段默认 SQLite，组织阶段默认 PostgreSQL。各驱动保持相同操作与事务语义：

```ts
interface AuthorityStore {
  findBySourceIdentity(identity: SourceIdentity): Promise<EventRecord | null>;
  append(input: NewEvent): Promise<EventRecord>;
  appendRevision(input: EventRevision): Promise<EventRecord>;
  markTombstone(input: TombstoneEvent): Promise<EventRecord>;
  putDisposition(decision: ArrangementDecision): Promise<void>;
  getDisposition(eventId: string): Promise<ArrangementDecision | null>;
  listInbox(orgId: string): Promise<InboxItem[]>;
}
```

`listInbox` 只返回各来源身份当前 head 且 disposition 为 `current_work` 的项。被 tombstone 或改成噪音的旧 Event 仍留在库里，但不进入 inbox。当前 head 若还没有 disposition，下一次采集该来源身份时补写，包括 duplicate 重放。

## 6. 规范输入契约

连接器产出带版本的 `IngestBatch`。该内部契约独立于任一来源 SDK。

```ts
interface IngestBatch {
  schema_version: "1.0";
  connector_id: string;
  org_id: string;
  delivery_id: string;
  records: IngestRecord[];
  next_cursor?: string;
  received_at: string;
}

interface IngestRecord {
  operation: "create" | "revise" | "tombstone";
  source: string;
  external_id: string;
  revision_id?: string;
  occurred_at: string;
  actor: ExternalPrincipalRef;
  scope: ExternalScopeRef;
  type: string;
  thread?: ExternalThreadRef;
  parent_external_id?: string;
  content?: ContentPart[];
  direction_tags?: string[];
  weight_hints?: WeightHints;
  attrs?: Record<string, JsonValue>;
}

interface ContentPart {
  role: "body" | "attachment" | "transcript" | "metadata";
  media_type: string;
  bytes?: Uint8Array;
  text?: string;
  external_locator?: string;
  source_filename?: string;
}
```

契约规则：

- 每个 content part 的 `bytes`、`text`、`external_locator` 恰好出现一个。
- 连接器通过已认证的来源客户端获取 `external_locator`；核心不接收来源凭据。
- 当来源账号不保证当前权威边界内唯一时，`external_id` 必须确定性加命名空间。
- `delivery_id` 用于 webhook 或轮询投递去重，不能替代 Event 幂等。
- 连接器特有字段保留在 `attrs`，但不得包含长正文或密钥。
- 未知记录类型根据连接器版本策略拒绝或进入隔离区，绝不能静默映射为 `message`。

## 7. 持久化

已接受 RFC 中的记录继续作为权威模型：

- `Blob`：内容寻址的正文元数据。
- `Event`：带 Blob 引用与 ACL scope 的轻量来源事件。
- 个人 owner 与来源 actor 出处。
- 启用组织层时的 `Principal`、`AclScope` 与 `AclMembership`。

可靠采集还需要在 `AuthorityStore` 中保存以下运维记录。

### 7.1 ConnectorInstallation

```text
id
org_id
source
status
config
credentials_ref
created_at
updated_at
```

`config` 中绝不出现密钥值。凭据通过 `SecretStore` 解析。

### 7.2 ConnectorCursor

```text
connector_id
stream_key
cursor
updated_at
lease_owner
lease_expires_at
```

Lease 防止轮询器重叠运行。游标推进与已完成批次结果一起提交。个人阶段可使用 SQLite 支撑的进程 lease；组织阶段可使用分布式 lease。

### 7.3 IngestAttempt

```text
id
org_id
connector_id
delivery_id
started_at
finished_at
status
accepted_count
duplicate_count
quarantined_count
error_code
```

该记录只包含运维元数据，不包含消息原文。

### 7.4 IngestQuarantine

```text
id
org_id
connector_id
delivery_id
record_identity
reason_code
safe_metadata
created_at
resolved_at
resolution
```

隔离区数据有意保持最小化。敏感内容留在来源系统中，映射问题修复后可以重新获取。对于无法重新获取的来源，诊断保留必须有明确的加密保留策略。

### 7.5 OutboxMessage

```text
id
org_id
topic
aggregate_id
payload
created_at
published_at
attempt_count
```

持久任务 payload 只包含标识符和安全路由元数据，绝不包含 Blob 正文。个人阶段由进程内 worker 直接消费已提交记录；组织阶段可由 transactional outbox publisher 转发到 BullMQ。

## 8. 处理流程

### 8.1 原生 API

1. 认证本地主体或组织 Principal。
2. 校验当前权威边界，以及适用时的目标 scope。
3. 通过原生适配器将请求转换为 `IngestBatch`。
4. 调用与外部连接器相同的采集服务。
5. 返回逐条处理结果与稳定 Event ID。

### 8.2 Webhook

1. 从路由而不是请求正文解析连接器安装实例。
2. 应用请求大小与速率限制。
3. 在解析业务内容前校验签名与防重放时间窗。
4. 将已验证 payload 转换为 `IngestBatch`。
5. 在返回成功前持久化规范处理结果。
6. 只有在不存在持久化结果时才返回可重试状态。
7. 通过 outbox 异步发布采集后工作。

必须在确认 webhook 前完成规范持久化，不能让来源数据的唯一副本只存在于未提交的队列消息中。

### 8.3 轮询

1. 获取连接器数据流 lease。
2. 读取已提交游标。
3. 从来源获取一个有界页面。
4. 将页面转换为 `IngestBatch`。
5. 持久化每条记录的处理结果。
6. 只有所有记录均为 accepted、duplicate 或已持久化进入隔离区时，才提交下一游标。
7. 释放或续租 lease。

### 8.4 回填

回填复用轮询路径，但使用固定时间范围、更小并发与更低优先级。它不能阻塞实时 webhook 采集。回填与 webhook 记录通过 Event 幂等收敛。

### 8.5 单条记录流程

```text
校验 IngestBatch
  -> 校验连接器与权威边界
  -> 解析本地 owner 或组织 Principal
  -> 解析个人来源 scope 或组织 ACL scope
  -> 校验写权限
  -> 规范化内容
  -> 计算 SHA-256
  -> 幂等 BlobStore.put
  -> 在 AuthorityStore 中追加 Event 或 revision
  -> 内核写入 disposition（过滤 / 分层）
  -> 追加审计与持久任务记录
  -> 返回 accepted | duplicate | quarantined
```

Event、审计、游标结果和持久任务变更使用同一个 `AuthorityStore` 事务。Blob 写入先执行并且幂等。事务失败可能留下无引用 Blob，由 GC 清理。禁止反向执行，因为 Event 绝不能引用缺失字节。

## 9. 幂等与来源变更

### 9.1 创建

来源身份为 `(org_id, source, external_id)`。使用相同规范内容哈希重复提交同一来源身份时，返回现有 Event，处理结果为 duplicate success。

### 9.2 冲突重复

相同来源身份对应不同内容时，不能覆盖。它必须成为：

- 连接器提供 revision 语义时的 revision；
- 与已知 revision 匹配时的乱序投递；
- 意图有歧义时，以 `source_identity_conflict` 进入隔离区。

### 9.3 Revision

Revision 是通过 `parent_event_id` 相连的追加式 Event。原 Event 保留以供出处追溯。优先使用来源稳定的 `revision_id`；若来源不提供，则让规范内容哈希参与生成确定性 revision identity。

当前来源状态由来源时间与采集顺序规则共同解析，而历史决策继续引用原始 Event。

### 9.4 Tombstone

撤回或删除会将目标来源事件标记为 tombstone，并创建审计记录。它不会立即删除 Blob 字节。保留与证据引用遵循 RFC 0005 GC 规则。

如果 tombstone 先于 create 到达，则按来源身份存储 pending tombstone。后续 create 直接以 tombstoned 状态持久化。

### 9.5 批次结果

独立记录之间不要求整个批次全成全败。每条记录获得一个持久化结果：

- `accepted`；
- `duplicate`；
- `quarantined`；
- `retryable_failure`。

游标不能跨过 `retryable_failure`。进入隔离区的记录不会阻塞游标，因为其持久化元数据支持后续处理。

## 10. 安全

### 10.1 信任边界

- Webhook 字节在签名验证成功前均不可信。
- 连接器输出对采集核心而言仍是不可信输入。
- 来源提供的 owner、组织、角色、ACL、哈希与 actor ID 绝不能直接作为内部 ID 接受。
- 连接器凭据保留在 `SecretStore` 与来源客户端之后。

### 10.2 个人与组织边界

- 个人导入只允许本地主体读取。来源 actor 和频道只作为出处，不成为本地授权。
- 组织阶段的外部频道映射为显式 `channel` scope。
- 组织成员同步可以授予或过期 membership，但不能创建组织管理员。
- 组织记录无法解析 scope 时进入隔离区。
- 组织 Service Principal 只能写入已配置 scope，并且必须拥有 `can_write_event`。
- Event 预览继承 Blob 的敏感级别。
- 运维日志不能包含正文、附件字节、访问令牌或已签名 webhook payload。

### 10.3 限制

以下限制同时在边缘与核心应用，并可配置：

- 请求字节数；
- 每批记录数；
- 每条记录的 content part 数；
- 正文、附件与解压后字节数；
- 每个时间窗口的连接器请求数；
- 回填范围与并发。

压缩包和文档解析器必须防御解压炸弹、路径穿越与畸形媒体。

## 11. 故障处理

| 类别 | 示例 | 结果 |
| --- | --- | --- |
| 永久输入错误 | schema 无效、不支持的类型 | 进入隔离区 |
| 映射错误 | 未知 actor 或 scope | 进入隔离区并告警 |
| 鉴权错误 | 连接器不能写入 scope | 拒绝、审计、不重试 |
| 来源暂时错误 | 超时、429、5xx | 按来源特性重试 |
| 存储暂时错误 | AuthorityStore 或 BlobStore 不可用 | 重试且不推进游标 |
| 冲突 | 来源身份对应有歧义的内容 | 进入隔离区 |
| 内部缺陷 | 不变量被破坏 | 批次失败、告警、保留游标 |

重试使用带抖动的指数退避，遵守 `Retry-After`，并限制重试时长和次数。每个连接器安装实例相互隔离。死信队列只提供运维可见性；持久化处理状态保留在 `AuthorityStore` 中。

## 12. 可观测性

### 12.1 指标

- 收到、接受、重复、隔离和失败的记录数；
- 按连接器和操作统计的采集延迟；
- 游标延迟与最早未处理来源时间；
- Blob 写入字节数与去重率；
- 未解析 Principal 与 scope 数量；
- webhook 签名与重放拒绝数；
- 重试数、限流时间与队列深度；
- outbox 发布延迟；
- 缺少 Blob 或必要边界引用的 Event 数，该指标必须始终为零。

### 12.2 日志与审计

结构化日志可以包含 correlation、attempt、connector、authority boundary、安全的来源身份、结果与原因标识符。日志不能包含正文、密钥、Authorization header 或隐藏的预览。

审计记录覆盖连接器安装变更、成员同步、Event 创建/revision/tombstone、隔离区处理，以及人工 replay 或 backfill 请求。

## 13. API 表面

个人端点在本地主体 scope 下使用相同资源形状：

```http
POST /v1/me/ingest/events
POST /v1/me/ingest/batches
GET  /v1/me/ingest/attempts/{attempt_id}
GET  /v1/me/events/{event_id}
GET  /v1/me/events/{event_id}/content
```

组织层提供对应的组织 scope 端点：

```http
POST /v1/orgs/{org_id}/ingest/events
POST /v1/orgs/{org_id}/ingest/batches
GET  /v1/orgs/{org_id}/ingest/attempts/{attempt_id}
GET  /v1/orgs/{org_id}/events/{event_id}
GET  /v1/orgs/{org_id}/events/{event_id}/content
```

连接器管理与事件提交保持分离：

```http
POST /v1/orgs/{org_id}/connectors
GET  /v1/orgs/{org_id}/connectors
POST /v1/orgs/{org_id}/connectors/{connector_id}:test
POST /v1/orgs/{org_id}/connectors/{connector_id}:backfill
POST /v1/orgs/{org_id}/connectors/{connector_id}:sync_members
```

Webhook 端点通过不透明 route token 标识安装实例：

```http
POST /v1/connector-webhooks/{route_token}
```

Route token 用于定位配置，但自身不足以完成认证。驱动仍须校验来源签名。

## 14. 仓库布局

```text
apps/api/src/ingest/
  ingest.controller.ts
  connector-webhook.controller.ts
  ingest.module.ts

apps/worker/src/connectors/
  connector-orchestrator.ts
  poll.processor.ts
  backfill.processor.ts
  membership.processor.ts
  outbox.processor.ts

packages/domain/src/ingest/
  contracts.ts
  canonicalization.ts
  errors.ts
  outcomes.ts

packages/connectors/
  src/port.ts
  src/native/
  src/testing/

packages/blob-store/
  src/port.ts
  src/memory/
  src/fs/
  src/minio/

packages/authority-store/
  src/port.ts
  src/sqlite/
  src/postgres/
  migrations/
  src/events/
  src/connectors/

packages/job-queue/
  src/port.ts
  src/inprocess/
  src/bullmq/
```

该布局描述所有权边界，并不要求立即创建所有 package。先完成一个垂直切片。只有至少两个实现使用某边界，或已接受 RFC 明确要求该端口时，才抽取 package。

## 15. 交付切片

### 15.1 契约 Fixture

- 定义 `IngestBatch`、处理结果、错误码与规范化 fixture。
- 测试重复创建、冲突重复、revision、tombstone、ACL 未解析与乱序投递。
- 建立连接器一致性测试框架。

退出标准：原生与外部适配器可以复用同一套契约测试。

### 15.2 本地个人采集

- 为 Event、Blob 元数据、个人边界、ingest attempt、quarantine 与持久任务记录添加最小 SQLite migration。
- 为测试实现内存 BlobStore，并提供本地文件系统驱动。
- 实现采集服务与 `/v1/me` 批量端点。
- 使用进程内任务队列添加事务集成测试。

退出标准：相同文本提交两次只返回一个 Event，并且出处与本地所有权稳定。

### 15.3 可靠运行

- 添加 outbox 发布、重试、指标、审计与隔离区查看。
- 添加 revision、tombstone 与 pending tombstone 行为。
- 添加通过 Event 鉴权的内容下载。

退出标准：故障注入证明不会出现 Blob 引用缺失、游标丢失或边界扩大。

### 15.4 连接器一致性

- 提供 fake connector 与一致性测试套件。
- 校验能力报告、确定性 external ID、批次限制、成员映射、重试与游标规则。

退出标准：新连接器无需运行第三方服务即可证明与核心兼容。

### 15.5 首个真实连接器

- 只实现首条真实工作流需要的来源能力。
- 运行一致性测试和 sandbox 端到端测试。

退出标准：一个人可以通过 webhook 或轮询在本地采集真实渠道，其数据通过同一个采集服务与原生输入收敛。

## 16. 验收标准

1. 重放相同原生请求、webhook、轮询页面或回填页面，不会重复创建 Event 或 Blob。
2. 两个个人权威存储或两个组织可以使用相同来源 ID，且不会冲突。
3. 连接器安装实例不能写出本地 owner 或组织边界。
4. 个人导入保持本地可见；未知组织 actor 或 scope 数据进入隔离区，绝不会变为组织可见。
5. 当前权威边界之外的调用方不能读取 Event 预览或 Blob。
6. 合法编辑创建相连的 revision，且不改变历史证据。
7. 撤回按策略隐藏内容，并为 GC 保留证据仍需的字节。
8. 先于 create 到达的 tombstone 会使后续 Event 以 tombstoned 状态创建。
9. AuthorityStore 失败不会推进连接器游标。
10. 队列或 outbox 失败不会丢失已提交 Event。
11. Blob 写入后数据库失败不会留下损坏的 Event 引用，且该 Blob 可被 GC 清理。
12. 一个失败或受限流的连接器不会阻塞其他安装实例。
13. 日志、指标、隔离区记录与 outbox 消息不包含正文或密钥。
14. 原生、fake 与首个真实连接器适配器均通过连接器一致性测试。
