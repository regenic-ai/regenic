# Technology stack

- **中文:** [../zh/TECH_STACK.md](../zh/TECH_STACK.md)
- **Related:** RFC 0004, RFC 0005, RFC 0006, RFC 0007

## 1. Stack

| Layer | Choice |
| --- | --- |
| API | NestJS (TypeScript) |
| Jobs | NestJS workers + BullMQ + Redis |
| Contract | OpenAPI 3 (`@nestjs/swagger`) |
| Database | PostgreSQL (system of record; not swapped by driver) |
| Object storage | `BlobStore` (§7) |
| Channel ingest | `ChannelConnector` (§8) |
| Models | `ModelProvider` (§9) |
| Identity | `IdentityProvider` (§10) |
| Authz | ACL (RFC 0006; in-app) |
| Search / vectors | `SearchIndex` (§11) |
| Push / OS notify | `Notifier` (§12) |
| Secrets | `SecretStore` (§13) |
| PC | Electron + React |
| Web | Next.js |
| Mobile | Expo (React Native) |
| Deploy | Docker Compose: `api`, `worker`, `web`, `postgres`, `redis`, + drivers as configured |

**Port vs fixed:** anything that changes by customer cloud or vendor is a port. Product runtime (Nest, clients, Postgres schema, ACL rules) stays fixed.

## 2. Repository

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
  blob-store/       BlobStore + drivers
  connectors/       ChannelConnector + drivers
  model-provider/   ModelProvider + drivers
  identity/         IdentityProvider + drivers
  search-index/     SearchIndex + drivers
  notifier/         Notifier + drivers
  secret-store/     SecretStore + drivers
```

## 3. Backend

- Modules: standards, context/events, ACL, digests, collaboration, runs
- HTTP/JSON: `/v1/orgs/{org_id}/...` (RFC 0004)
- Workers: connector sync, distillation, GC, notifications
- Distillation / agent runs call `ModelProvider` only

| Store | Contents |
| --- | --- |
| PostgreSQL | Events, Digests, Standards, ACL, Claims, Snapshots |
| BlobStore | Blob bodies |
| Redis | BullMQ, short cache |
| SearchIndex | optional full-text / vectors |

## 4. Clients

| App | Stack | Scope |
| --- | --- | --- |
| Desktop | Electron + React | workbench, tray, OS notifications, multi-window, shortcuts |
| Web | Next.js | admin, connectors, SSO, browser access |
| Mobile | Expo | capture, push, digest/handoff confirm, agent threads |

| Capability | Desktop | Web | Mobile |
| --- | --- | --- | --- |
| Human ↔ agent threads | ● | ○ | ● |
| Digest / bad-news actions | ● | ● | ● |
| Standard authoring | ● | ● | ○ |
| ACL & connector admin | ● | ● | — |
| Notifications | ● | ○ | ● |

● primary · ○ supported · — none

## 5. Realtime (in-app)

WebSocket or SSE via Nest. Delivery to device OS uses `Notifier` (§12).

## 6. Ports overview

| Port | Swappable | Fixed behind port |
| --- | --- | --- |
| `BlobStore` | MinIO / S3 / OSS | `content_hash` addressing |
| `ChannelConnector` | Feishu / WeCom / Slack / ticket / CS / … | Event + Blob + ACL membership |
| `ModelProvider` | OpenAI / Azure / 通义 / vLLM / … | propose/embed interfaces for workers |
| `IdentityProvider` | Keycloak / Authing / Azure AD / Feishu SSO / … | Principal mapping into RFC 0006 |
| `SearchIndex` | pgvector / OpenSearch / none | ACL-filtered query API |
| `Notifier` | Electron / APNs / FCM / WeCom app msg / … | notification event schema |
| `SecretStore` | env / file / Vault / cloud KMS / … | `credentials_ref` resolution |

## 7. Object storage (`BlobStore`)

```text
put(hash, bytes, media_type) → void
get(hash) → bytes
delete(hash) → void
exists(hash) → bool
```

| Driver | Typical use |
| --- | --- |
| `minio` | private Compose default |
| `s3` | AWS S3 or S3-compatible |
| `oss` | Alibaba Cloud OSS |

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

- Address key: `content_hash`. `storage_uri` is ops metadata only.
- Domain/GC/digest call the port only.

## 8. Channel ingest (`ChannelConnector`)

```text
capabilities() → { webhook, poll, backfill, member_sync }
verify_webhook(req) → ok | reject
handle_webhook(req) → IngestBatch
poll(cursor) → { batch, next_cursor }
backfill(range) → async job id
sync_members(channel_ref) → membership diffs
```

| Driver (examples) | Source |
| --- | --- |
| `feishu` | 飞书 |
| `wecom` | 企业微信 |
| `slack` | Slack |
| `regenic` | native clients |
| `ticket` | ticket systems |
| `cs` | customer-service systems |

```yaml
connectors:
  - id: feishu-main
    driver: feishu
    enabled: true
    credentials_ref: ...
    sync: { members: true, history_days: 30 }
```

- Idempotency: `Event.source` + `Event.external_id`
- Member sync → channel AclScope (RFC 0006)
- Driver queue isolation on failure

## 9. Models (`ModelProvider`)

```text
complete(request) → text | json   # D1 propose, agent assists
embed(texts[]) → vectors[]       # optional clustering / search
health() → ok | degraded
```

| Driver (examples) | Notes |
| --- | --- |
| `openai` | OpenAI API |
| `azure_openai` | Azure-hosted |
| `dashscope` | 通义等 |
| `openai_compatible` | vLLM / Ollama / one-API gateways |
| `none` | D0 rules-only (RFC 0007) |

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

- Scoring, quotas, ACL, conflicts stay in code (RFC 0007)—not in the model driver.
- Org may override deployment defaults.

## 10. Identity (`IdentityProvider`)

```text
authorization_url(state) → url
exchange_code(code) → ExternalIdentity
jwks() | validate_token(token) → claims
map_to_principal(identity) → Principal id  # upsert
```

| Driver (examples) | Notes |
| --- | --- |
| `oidc_generic` | Keycloak, Authing, Okta, Azure AD (OIDC) |
| `feishu_sso` | 飞书登录 |
| `wecom_sso` | 企业微信登录 |

- ACL membership is Regenic-owned (RFC 0006). IdP only authenticates and supplies external ids / groups hints.
- Group → AclScope sync is optional config, not implicit admin.

## 11. Search / vectors (`SearchIndex`)

```text
upsert(doc) → void          # id, text/vector, acl_scope_ids, org_id
delete(id) → void
query(q, principal) → hits  # ACL filter mandatory before rank
```

| Driver | Typical use |
| --- | --- |
| `noop` | no external index |
| `pgvector` | default when vectors enabled |
| `opensearch` | larger full-text / hybrid |

- Query path must apply the same `visible()` constraints as list APIs.

## 12. Notifier (`Notifier`)

```text
send(principal_id, notification) → void
```

| Driver | Channel |
| --- | --- |
| `electron` | desktop OS notify / badge |
| `apns` | iOS |
| `fcm` | Android |
| `wecom_app` | optional 企微应用消息 |
| `webhook` | customer callback |

In-app WS/SSE is separate from device push. Same notification schema feeds all drivers.

## 13. Secrets (`SecretStore`)

```text
resolve(ref) → secret_bytes
```

| Driver | Typical use |
| --- | --- |
| `env` | local / Compose |
| `file` | mounted secrets |
| `vault` | HashiCorp Vault |
| `aws_sm` | AWS Secrets Manager |
| `aliyun_kms` | 阿里云 KMS / 凭据助手 |

All `*_ref` fields in connector / blob / model config resolve through this port.
