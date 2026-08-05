# 技术栈

- **English:** [../en/TECH_STACK.md](../en/TECH_STACK.md)
- **相关：** RFC 0004、RFC 0005、RFC 0006、RFC 0007

## 1. 选型

| 层 | 技术 |
| --- | --- |
| API | NestJS（TypeScript） |
| 任务 | NestJS worker + BullMQ + Redis |
| 契约 | OpenAPI 3（`@nestjs/swagger`） |
| 数据库 | PostgreSQL（权威库；不靠驱动替换） |
| 对象存储 | `BlobStore`（§7） |
| 渠道接入 | `ChannelConnector`（§8） |
| 模型 | `ModelProvider`（§9） |
| 身份 | `IdentityProvider`（§10） |
| 鉴权 | ACL（RFC 0006；应用内） |
| 检索 / 向量 | `SearchIndex`（§11） |
| 推送 / OS 通知 | `Notifier`（§12） |
| 密钥 | `SecretStore`（§13） |
| PC | Electron + React |
| Web | Next.js |
| 手机 | Expo（React Native） |
| 部署 | Docker Compose：`api`、`worker`、`web`、`postgres`、`redis`，其余按驱动配置 |

**端口 vs 固定：** 随客户云/厂商变化的做成端口。产品运行时（Nest、客户端、Postgres schema、ACL 规则）固定。

## 2. 仓库

```text
apps/
  api/
  worker/
  desktop/
  web/
  mobile/
packages/
  api-client/
  domain/
  ui/
  config/
  blob-store/       BlobStore + 驱动
  connectors/       ChannelConnector + 驱动
  model-provider/   ModelProvider + 驱动
  identity/         IdentityProvider + 驱动
  search-index/     SearchIndex + 驱动
  notifier/         Notifier + 驱动
  secret-store/     SecretStore + 驱动
```

## 3. 后端

- 模块：standards、context/events、ACL、digests、collaboration、runs
- HTTP/JSON：`/v1/orgs/{org_id}/...`（RFC 0004）
- Worker：连接器同步、蒸馏、GC、通知
- 蒸馏 / Agent 运行只调用 `ModelProvider`

| 存储 | 内容 |
| --- | --- |
| PostgreSQL | Event、Digest、Standard、ACL、Claim、Snapshot |
| BlobStore | Blob 正文 |
| Redis | BullMQ、短缓存 |
| SearchIndex | 可选全文 / 向量 |

## 4. 客户端

| 应用 | 技术 | 范围 |
| --- | --- | --- |
| Desktop | Electron + React | 工作台、托盘、系统通知、多窗口、快捷键 |
| Web | Next.js | 管理、连接器、SSO、浏览器访问 |
| Mobile | Expo | 捕获、推送、Digest/Handoff 确认、Agent 会话 |

| 能力 | Desktop | Web | Mobile |
| --- | --- | --- | --- |
| 人 ↔ Agent 线程 | ● | ○ | ● |
| Digest / 坏消息操作 | ● | ● | ● |
| 标准撰写 | ● | ● | ○ |
| ACL 与连接器管理 | ● | ● | — |
| 通知 | ● | ○ | ● |

● 主 · ○ 支持 · — 无

## 5. 应用内实时

Nest 提供 WebSocket 或 SSE。打到设备 OS 的通道走 `Notifier`（§12）。

## 6. 端口一览

| 端口 | 可替换 | 端口后固定 |
| --- | --- | --- |
| `BlobStore` | MinIO / S3 / OSS | `content_hash` 寻址 |
| `ChannelConnector` | 飞书 / 企微 / Slack / 工单 / 客服 / … | Event + Blob + ACL membership |
| `ModelProvider` | OpenAI / Azure / 通义 / vLLM / … | worker 的 complete/embed |
| `IdentityProvider` | Keycloak / Authing / Azure AD / 飞书 SSO / … | 映射为 RFC 0006 Principal |
| `SearchIndex` | pgvector / OpenSearch / none | 带 ACL 的查询 API |
| `Notifier` | Electron / APNs / FCM / 企微应用消息 / … | 通知事件 schema |
| `SecretStore` | env / file / Vault / 云 KMS / … | 解析 `credentials_ref` |

## 7. 对象存储（`BlobStore`）

```text
put(hash, bytes, media_type) → void
get(hash) → bytes
delete(hash) → void
exists(hash) → bool
```

| 驱动 | 典型场景 |
| --- | --- |
| `minio` | 私有化 Compose 默认 |
| `s3` | AWS S3 或 S3 兼容 |
| `oss` | 阿里云 OSS |

```yaml
blob_store:
  driver: minio | s3 | oss
  endpoint: ...
  bucket: ...
  region: ...
  access_key_ref: ...
  secret_key_ref: ...
  prefix: org/{org_id}/
```

- 寻址键：`content_hash`。`storage_uri` 仅运维元数据。
- 领域 / GC / 蒸馏只调端口。

## 8. 渠道接入（`ChannelConnector`）

```text
capabilities() → { webhook, poll, backfill, member_sync }
verify_webhook(req) → ok | reject
handle_webhook(req) → IngestBatch
poll(cursor) → { batch, next_cursor }
backfill(range) → async job id
sync_members(channel_ref) → membership diffs
```

| 驱动（示例） | 来源 |
| --- | --- |
| `feishu` | 飞书 |
| `wecom` | 企业微信 |
| `slack` | Slack |
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

- 幂等：`Event.source` + `Event.external_id`
- 成员同步 → channel AclScope（RFC 0006）
- 单驱动队列失败隔离

## 9. 模型（`ModelProvider`）

```text
complete(request) → text | json   # D1 提案、Agent 辅助
embed(texts[]) → vectors[]       # 可选聚类 / 检索
health() → ok | degraded
```

| 驱动（示例） | 说明 |
| --- | --- |
| `openai` | OpenAI API |
| `azure_openai` | Azure |
| `dashscope` | 通义等 |
| `openai_compatible` | vLLM / Ollama / 中转网关 |
| `none` | 仅 D0 规则（RFC 0007） |

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

- 打分、配额、ACL、冲突在代码中（RFC 0007），不在模型驱动里。
- org 可覆盖部署默认。

## 10. 身份（`IdentityProvider`）

```text
authorization_url(state) → url
exchange_code(code) → ExternalIdentity
jwks() | validate_token(token) → claims
map_to_principal(identity) → Principal id  # upsert
```

| 驱动（示例） | 说明 |
| --- | --- |
| `oidc_generic` | Keycloak、Authing、Okta、Azure AD（OIDC） |
| `feishu_sso` | 飞书登录 |
| `wecom_sso` | 企业微信登录 |

- ACL membership 由 Regenic 自有（RFC 0006）。IdP 只负责认证与外部 id / 组提示。
- 组 → AclScope 为可选同步，不隐含管理员。

## 11. 检索 / 向量（`SearchIndex`）

```text
upsert(doc) → void          # id, text/vector, acl_scope_ids, org_id
delete(id) → void
query(q, principal) → hits  # 必须先 ACL 再排序
```

| 驱动 | 典型场景 |
| --- | --- |
| `noop` | 无外部索引 |
| `pgvector` | 启用向量时的默认 |
| `opensearch` | 更大规模全文 / 混合检索 |

- 查询路径与列表 API 同一套 `visible()` 约束。

## 12. 通知（`Notifier`）

```text
send(principal_id, notification) → void
```

| 驱动 | 通道 |
| --- | --- |
| `electron` | 桌面 OS 通知 / 角标 |
| `apns` | iOS |
| `fcm` | Android |
| `wecom_app` | 可选企微应用消息 |
| `webhook` | 客户回调 |

应用内 WS/SSE 与设备推送分离。同一通知 schema 喂给各驱动。

## 13. 密钥（`SecretStore`）

```text
resolve(ref) → secret_bytes
```

| 驱动 | 典型场景 |
| --- | --- |
| `env` | 本地 / Compose |
| `file` | 挂载密钥文件 |
| `vault` | HashiCorp Vault |
| `aws_sm` | AWS Secrets Manager |
| `aliyun_kms` | 阿里云 KMS / 凭据 |

连接器 / 对象存储 / 模型配置里的 `*_ref` 均经此端口解析。
