# 技术栈

- **English:** [../en/TECH_STACK.md](../en/TECH_STACK.md)
- **相关：** [产品](PRODUCT.md) · [消息编排](MESSAGE_ORCHESTRATION.md) · [连接器](CONNECTOR.md) · [路线图](ROADMAP.md) · [桌面端](DESKTOP.md) · RFC 0004、0005、0006、0007、0008、0009

个人版默认**本地优先**，随后是组织层。领域模型和接口形状尽量共用；
换的是各阶段的**默认实现**，不是另起一套产品。

连接器、模型、存储做成**插件**（端口加驱动）。插件宿主是 `@regenic/plugin-host`（内部用 [Cordis](https://github.com/cordiverse/cordis) 做可逆装卸）。业务包只依赖这层 API，不直接依赖 `cordis`。内核语义固定：
消息格式（`IngestBatch`）、Event / Blob / Digest / Standard、ACL、记录类 / 线程面 / WorkItem、接入 → 过滤 → 分层 → 调度。
执行走 `ctx.executors` 上的 `TaskExecutor`。
详见[消息编排](MESSAGE_ORCHESTRATION.md)。

## 1. 各阶段默认

| | 个人（Phase 1，当前） | 组织 / 自托管服务（Phase 3+） |
| --- | --- | --- |
| 权威库 | SQLite（本机一个文件） | PostgreSQL |
| 正文（Blob） | 本地目录 | MinIO / S3 / OSS |
| 后台任务 | 进程内队列 | BullMQ + Redis |
| 身份 | 本机一个用户 | OIDC / 渠道 SSO |
| 检索 | 先 noop；需要时用 SQLite FTS | pgvector / OpenSearch（可选） |
| 密钥 | 系统钥匙串 / 本地文件 | Vault 或云 KMS（可选） |
| 客户端 | Electron | 桌面为主；Web 管配置；手机稍后 |
| 运行方式 | 本机，或嵌在桌面应用里 | Docker Compose |

用户可选的「远端历史」默认关闭，只是冷备份。权威数据仍在本地，
也不是组织库。

## 2. 组件

| 层 | 选择 |
| --- | --- |
| API | NestJS（TypeScript） |
| 任务 | `JobQueue`：进程内，或 BullMQ + Redis |
| API 契约 | OpenAPI 3（`@nestjs/swagger`） |
| 权威库 | `AuthorityStore`：SQLite 或 PostgreSQL |
| 对象存储 | `BlobStore` |
| 渠道接入 | `ChannelConnector`（连接器） |
| 渠道发送 | `EgressAdapter`（发送路径；Phase 2） |
| 托管执行 | `TaskExecutor`（公开默认 `dsh`） |
| 上下文发布 | `ContextConsumer`（未来；仅 Evidence Bundle） |
| 模型 | `ModelProvider` |
| 身份 | `IdentityProvider` |
| 权限 | 应用内 ACL（RFC 0006） |
| 检索 | `SearchIndex` |
| 系统通知 | `Notifier` |
| 密钥 | `SecretStore` |
| 桌面 | Electron + React |
| Web | Next.js（组织管理、浏览器访问；个人阶段不做） |
| 手机 | Expo（捕获 / 推送；个人阶段不做） |

## 3. 仓库结构

```text
apps/
  api/              Nest API（本机嵌套，或 Compose 里的服务）
  worker/           后台任务（个人阶段可以和 api 同进程）
  desktop/          Electron（个人阶段主界面）
  web/              Next.js（后做）
  mobile/           Expo（后做）
packages/
  api-client/
  domain/
  ui/
  config/
  plugin-host/      插件宿主（Cordis 的唯一入口）
  authority-store/  AuthorityStore + 驱动
  blob-store/       BlobStore + 驱动
  job-queue/        JobQueue + 驱动
  connectors/       ChannelConnector
  egress/           EgressAdapter（Phase 2）
  model-provider/   ModelProvider + 驱动
  identity/         IdentityProvider + 驱动
  search-index/     SearchIndex + 驱动
  notifier/         Notifier + 驱动
  secret-store/     SecretStore + 驱动
```

Phase 1 落地 `api`（带进程内 worker）、`desktop` 以及运行所需的 packages。
不必预先创建全部应用。

## 4. 后端

- 模块大致按：standards、context/events、ACL、digests、collaboration、runs
- HTTP：
  - 个人：`/v1/me/...`（资源形状跟 RFC 0004 对齐，不必硬套 org 路径）
  - 组织：`/v1/orgs/{org_id}/...`
- 后台任务：连接器同步、蒸馏、GC、通知
- 调模型只走 `ModelProvider`

| 存储 | 内容 |
| --- | --- |
| AuthorityStore | Event 瘦行、Digest、Standard、ACL、Claim、Snapshot |
| BlobStore | Blob 正文 |
| JobQueue | 异步任务；个人阶段不单独起 Redis |
| SearchIndex | 可选的全文 / 向量 |

## 5. 客户端

| 应用 | 技术 | 阶段 | 职责 |
| --- | --- | --- | --- |
| Desktop | Electron + React | Phase 1 | 工作台、托盘、系统通知、本机库（[桌面端](DESKTOP.md)） |
| Web | Next.js | Phase 3+ | 管理、连接器、SSO |
| Mobile | Expo | 稍后 | 捕获、推送、确认类操作 |

| 能力 | 桌面 | Web | 手机 |
| --- | --- | --- | --- |
| 人 ↔ Agent 对话 | ● | ○ | ● |
| Digest / 跟进 | ● | ● | ● |
| 写标准 | ● | ● | ○ |
| ACL / 连接器配置 | ● | ● | — |
| 通知 | ● | ○ | ● |

● 主路径 · ○ 能用 · — 不做

## 6. 任务队列（`JobQueue`）

```text
enqueue(job) → id
process(handler) → void
```

| 驱动 | 用途 |
| --- | --- |
| `inprocess` | 个人默认 |
| `bullmq` | 组织 / Compose（要 Redis） |

## 7. 权威库（`AuthorityStore`）

关系型权威数据。驱动可换，表结构和查询语义尽量共用。

| 驱动 | 用途 |
| --- | --- |
| `sqlite` | 个人默认：单文件，便于备份与随应用迁移 |
| `postgres` | 组织或多用户自托管 |

- 个人阶段没有多租户分区；组织侧按 RFC 0005 给 `org_id`、时间建索引。
- 导出走领域格式（Markdown / JSONL），不要绑死某个数据库的 dump。

## 8. 对象存储（`BlobStore`）

```text
put(hash, bytes, media_type) → void
get(hash) → bytes
delete(hash) → void
exists(hash) → bool
```

| 驱动 | 用途 |
| --- | --- |
| `fs` | 个人默认：本地目录 |
| `minio` | Compose 私有化常用 |
| `s3` | AWS S3 或兼容实现 |
| `oss` | 阿里云 OSS |

```yaml
blob_store:
  driver: fs | minio | s3 | oss
  # fs:
  root: ~/.regenic/blobs
  # 对象存储:
  endpoint: ...
  bucket: ...
  prefix: org/{org_id}/   # 组织；个人可用固定前缀
```

正文按 `content_hash` 寻址。`storage_uri` 只给运维看。
业务代码（含 GC、蒸馏）只调端口，不直连某个云 SDK。

## 9. 渠道接入（`ChannelConnector`）

实现合同：[连接器](CONNECTOR.md)。

```text
capabilities() → { webhook, poll, backfill, member_sync }
verify_webhook(req) → ok | reject
handle_webhook(req) → IngestBatch
poll(cursor) → { batch, next_cursor }
backfill(range) → async job id
sync_members(channel_ref) → membership diffs
```

| 驱动（举例） | 来源 |
| --- | --- |
| `feishu` | 飞书 |
| `wecom` | 企业微信 |
| `slack` | Slack |
| `dsh` | DeepSeek Harness：`cli`（headless）或 `web`（HTTP session） |
| `email` | 邮件（多为拉取） |
| `regenic` | 自有客户端 |
| `ticket` | 工单 |
| `cs` | 客服 |

```yaml
connectors:
  - id: feishu-main
    driver: feishu
    enabled: true
    credentials_ref: ...
    sync: { members: true, history_days: 30 }
```

- 幂等键：`Event.source` + `Event.external_id`
- 某个连接器失败时，不得阻塞其他连接器
- 个人阶段先把拉取 / 推送接进来；成员同步（`member_sync`）主要在组织阶段用
- 连接器只翻译，绝不直写 Event 或 Blob（见[采集架构](INGESTION_ARCHITECTURE.md)）

## 9.1 渠道发送（`EgressAdapter`）

Phase 2。与连接器同一渠道身份。蒸馏不等于发送权。

```text
capabilities() → { reply, edit, tombstone }
send(intent) → DeliveryReceipt
```

| 驱动（举例） | 去向 |
| --- | --- |
| `slack` | Slack 回复 / 发帖 |
| `dsh` | CLI headless，或 web `session.prompt` |
| `email` | 邮件厂商 API |
| `feishu` | 飞书消息 |

内核发出发送请求（目标 Event、正文 hash、actor、审批）。连接器对接渠道。
发送失败不得改写历史。

## 10. 模型（`ModelProvider`）

```text
complete(request) → text | json   # 提案、Agent 辅助
embed(texts[]) → vectors[]       # 可选
health() → ok | degraded
```

| 驱动（举例） | 说明 |
| --- | --- |
| `openai` | OpenAI |
| `azure_openai` | Azure |
| `dashscope` | 通义等 |
| `openai_compatible` | vLLM / Ollama / 兼容网关 |
| `none` | 只用规则路径（RFC 0007 的 D0） |

```yaml
model_provider:
  complete:
    driver: openai_compatible
    base_url: ...
    model: ...
    api_key_ref: ...
  embed:
    driver: openai_compatible
    model: ...
    api_key_ref: ...
```

打分、配额、权限、冲突处理写在内核里（见 RFC 0007），
不放入模型驱动。个人阶段可以默认 `none`，或接本机 Ollama。

## 11. 身份（`IdentityProvider`）

```text
authorization_url(state) → url
exchange_code(code) → ExternalIdentity
jwks() | validate_token(token) → claims
map_to_principal(identity) → Principal id
```

| 驱动（举例） | 说明 |
| --- | --- |
| `local` | 个人默认：本机一个用户，没有外部登录 |
| `oidc_generic` | Keycloak、Authing、Okta、Azure AD 等 |
| `feishu_sso` | 飞书登录 |
| `wecom_sso` | 企业微信登录 |

可见性由 Regenic ACL 控制（RFC 0006）。
IdP 只负责认证，以及外部账号 / 组的提示。组同步成 AclScope 是可选配置，
不等于自动给管理员。

## 12. 检索（`SearchIndex`）

```text
upsert(doc) → void
delete(id) → void
query(q, principal) → hits   # 先按可见性过滤，再排序
```

| 驱动 | 用途 |
| --- | --- |
| `noop` | 暂不启用外部索引 |
| `sqlite_fts` | 个人阶段要全文时 |
| `pgvector` | 组织侧开向量时 |
| `opensearch` | 更大规模 |

查询和列表 API 同一套可见性规则。个人阶段可以简化成「只有当前用户」。

## 13. 通知（`Notifier`）

```text
send(principal_id, notification) → void
```

| 驱动 | 通道 |
| --- | --- |
| `electron` | 桌面系统通知（个人阶段主通道） |
| `apns` | iOS |
| `fcm` | Android |
| `wecom_app` | 企微应用消息（可选） |
| `webhook` | 回调 |

应用内的 WebSocket / SSE，和打到操作系统的推送分开。通知内容用同一套 schema。

## 14. 密钥（`SecretStore`）

```text
resolve(ref) → secret_bytes
```

| 驱动 | 用途 |
| --- | --- |
| `keychain` | 个人默认：系统凭据库 |
| `file` | 本地或挂载的密钥文件 |
| `env` | 开发 / Compose |
| `vault` | HashiCorp Vault |
| `aws_sm` | AWS Secrets Manager |
| `aliyun_kms` | 阿里云 KMS |

连接器、对象存储、模型配置里的 `*_ref`，都从这里解析。

## 15. 应用内实时

Nest 上开 WebSocket 或 SSE。要弹到系统托盘 / 锁屏的，走 `Notifier`。

## 16. 端口一览

| 端口 | 可替换实现 | 不变量 |
| --- | --- | --- |
| `AuthorityStore` | SQLite / PostgreSQL | 领域表与查询语义 |
| `JobQueue` | 进程内 / BullMQ | 任务类型与幂等键 |
| `BlobStore` | fs / MinIO / S3 / OSS | 按 `content_hash` 寻址 |
| `ChannelConnector` | 飞书 / 企微 / Slack / DSH / 邮件 / … | 只写出 `IngestBatch` |
| `EgressAdapter` | 同一批来源的发送 | 回复 → 渠道；不得自授权 |
| `ModelProvider` | OpenAI / Azure / 通义 / vLLM / none | complete / embed 接口 |
| `IdentityProvider` | local / OIDC / 飞书 SSO / … | 映射成 RFC 0006 的 Principal |
| `SearchIndex` | noop / sqlite_fts / pgvector / … | 带可见性过滤的查询 |
| `Notifier` | Electron / APNs / FCM / … | 通知事件形状 |
| `SecretStore` | keychain / file / env / Vault / … | 解析 `credentials_ref` |
