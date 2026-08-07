# Technology stack

- **中文:** [../zh/TECH_STACK.md](../zh/TECH_STACK.md)
- **Related:** [PRODUCT.md](PRODUCT.md) · [ROADMAP.md](ROADMAP.md) · RFC 0004, 0005, 0006, 0007

We ship **local-first Personal** first, then Org. Same domain model and API
shapes; what changes by phase is the **default drivers**, not a second product.

Anything that depends on a vendor or deploy shape is a port. The processing
semantics stay fixed: Event / Blob / Digest / Standard, ACL, and
ingest → filter → layer → distill.

## 1. Defaults by phase

| | Personal (Phase 1, now) | Org / self-hosted (Phase 3+) |
| --- | --- | --- |
| Authority DB | SQLite (one file on disk) | PostgreSQL |
| Blob bodies | Local directory | MinIO / S3 / OSS |
| Background jobs | In-process queue | BullMQ + Redis |
| Identity | One local user | OIDC / channel SSO |
| Search | noop first; SQLite FTS if needed | pgvector / OpenSearch (optional) |
| Secrets | OS keychain / local file | Vault or cloud KMS (optional) |
| Clients | Electron | Desktop first; Web for admin; mobile later |
| How you run it | On the machine, or embedded in the desktop app | Docker Compose |

Optional remote history is off by default. It is a cold backup the user opts
into — not the authority store, and not the org database.

## 2. What we use

| Layer | Choice |
| --- | --- |
| API | NestJS (TypeScript) |
| Jobs | `JobQueue`: in-process, or BullMQ + Redis |
| Contract | OpenAPI 3 (`@nestjs/swagger`) |
| Authority DB | `AuthorityStore`: SQLite or PostgreSQL |
| Object storage | `BlobStore` |
| Channel ingest | `ChannelConnector` |
| Models | `ModelProvider` |
| Identity | `IdentityProvider` |
| Authz | In-app ACL (RFC 0006) |
| Search | `SearchIndex` |
| OS notifications | `Notifier` |
| Secrets | `SecretStore` |
| Desktop | Electron + React |
| Web | Next.js (org admin / browser; skip for Personal) |
| Mobile | Expo (capture / push; skip for Personal) |

## 3. Repository layout

```text
apps/
  api/              Nest API (embedded locally, or a Compose service)
  worker/           background jobs (may share the api process in Personal)
  desktop/          Electron (primary UI in Personal)
  web/              Next.js (later)
  mobile/           Expo (later)
packages/
  api-client/
  domain/
  ui/
  config/
  authority-store/  AuthorityStore + drivers
  blob-store/       BlobStore + drivers
  job-queue/        JobQueue + drivers
  connectors/       ChannelConnector + drivers
  model-provider/   ModelProvider + drivers
  identity/         IdentityProvider + drivers
  search-index/     SearchIndex + drivers
  notifier/         Notifier + drivers
  secret-store/     SecretStore + drivers
```

For Phase 1, land `api` (with an in-process worker), `desktop`, and the packages
you need. Do not require every app up front.

## 4. Backend

- Modules roughly: standards, context/events, ACL, digests, collaboration, runs
- HTTP:
  - Personal: `/v1/me/...` (same resource shapes as RFC 0004; no need to force
    an org path)
  - Org: `/v1/orgs/{org_id}/...`
- Workers: connector sync, distillation, GC, notifications
- Model calls go only through `ModelProvider`

| Store | Holds |
| --- | --- |
| AuthorityStore | thin Events, Digests, Standards, ACL, Claims, Snapshots |
| BlobStore | Blob bodies |
| JobQueue | async work; no dedicated Redis in Personal |
| SearchIndex | optional full-text / vectors |

## 5. Clients

| App | Stack | When | Role |
| --- | --- | --- | --- |
| Desktop | Electron + React | Phase 1 | workbench, tray, OS notify, local store |
| Web | Next.js | Phase 3+ | admin, connectors, SSO |
| Mobile | Expo | later | capture, push, confirmations |

| Capability | Desktop | Web | Mobile |
| --- | --- | --- | --- |
| Human ↔ agent threads | ● | ○ | ● |
| Digest / follow-up | ● | ● | ● |
| Standard authoring | ● | ● | ○ |
| ACL / connector admin | ● | ● | — |
| Notifications | ● | ○ | ● |

● primary · ○ supported · — out of scope

## 6. Job queue (`JobQueue`)

```text
enqueue(job) → id
process(handler) → void
```

| Driver | Use |
| --- | --- |
| `inprocess` | Personal default |
| `bullmq` | Org / Compose (needs Redis) |

## 7. Authority store (`AuthorityStore`)

Relational system of record. Drivers swap; table shapes and query semantics
should stay shared.

| Driver | Use |
| --- | --- |
| `sqlite` | Personal default: one file, easy to back up and carry |
| `postgres` | Org or multi-user self-host |

- Personal has no multi-tenant partitioning. Org indexes by `org_id` / time per
  RFC 0005.
- Export is domain format (Markdown / JSONL), not a database dump format.

## 8. Object storage (`BlobStore`)

```text
put(hash, bytes, media_type) → void
get(hash) → bytes
delete(hash) → void
exists(hash) → bool
```

| Driver | Use |
| --- | --- |
| `fs` | Personal default: local directory |
| `minio` | common private Compose setup |
| `s3` | AWS S3 or S3-compatible |
| `oss` | Alibaba Cloud OSS |

```yaml
blob_store:
  driver: fs | minio | s3 | oss
  # fs:
  root: ~/.regenic/blobs
  # object stores:
  endpoint: ...
  bucket: ...
  prefix: org/{org_id}/   # Org; Personal can use a fixed prefix
```

Address by `content_hash`. `storage_uri` is ops metadata only.
Domain code (including GC and distillation) talks to the port, not a cloud SDK.

## 9. Channel ingest (`ChannelConnector`)

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
| `feishu` | Feishu |
| `wecom` | WeCom |
| `slack` | Slack |
| `email` | mail (often pull) |
| `regenic` | our own clients |
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
- One failing connector must not stall the others
- Personal focuses on push/pull ingest; `member_sync` matters mainly for Org

## 10. Models (`ModelProvider`)

```text
complete(request) → text | json   # proposals, agent assists
embed(texts[]) → vectors[]       # optional
health() → ok | degraded
```

| Driver (examples) | Notes |
| --- | --- |
| `openai` | OpenAI |
| `azure_openai` | Azure |
| `dashscope` | 通义 and similar |
| `openai_compatible` | vLLM / Ollama / compatible gateways |
| `none` | rules-only path (D0 in RFC 0007) |

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

Scoring, quotas, ACL, and conflict handling live in our code (RFC 0007), not
inside the model driver. Personal can default to `none`, or talk to local
Ollama.

## 11. Identity (`IdentityProvider`)

```text
authorization_url(state) → url
exchange_code(code) → ExternalIdentity
jwks() | validate_token(token) → claims
map_to_principal(identity) → Principal id
```

| Driver (examples) | Notes |
| --- | --- |
| `local` | Personal default: one on-device user, no external login |
| `oidc_generic` | Keycloak, Authing, Okta, Azure AD, … |
| `feishu_sso` | Feishu login |
| `wecom_sso` | WeCom login |

Visibility is owned by Regenic ACL (RFC 0006). The IdP authenticates and may
hint external ids / groups. Syncing groups into AclScope is optional config,
not an implicit admin grant.

## 12. Search (`SearchIndex`)

```text
upsert(doc) → void
delete(id) → void
query(q, principal) → hits   # filter by visibility, then rank
```

| Driver | Use |
| --- | --- |
| `noop` | no external index yet |
| `sqlite_fts` | Personal full-text when needed |
| `pgvector` | Org when vectors are on |
| `opensearch` | larger scale |

Search uses the same visibility rules as list APIs. Personal can simplify to
“current user only”.

## 13. Notifier (`Notifier`)

```text
send(principal_id, notification) → void
```

| Driver | Channel |
| --- | --- |
| `electron` | desktop OS notify (primary in Personal) |
| `apns` | iOS |
| `fcm` | Android |
| `wecom_app` | optional WeCom app messages |
| `webhook` | callback |

In-app WebSocket / SSE is separate from OS push. Same notification schema for
every driver.

## 14. Secrets (`SecretStore`)

```text
resolve(ref) → secret_bytes
```

| Driver | Use |
| --- | --- |
| `keychain` | Personal default: OS credential store |
| `file` | local or mounted secret files |
| `env` | dev / Compose |
| `vault` | HashiCorp Vault |
| `aws_sm` | AWS Secrets Manager |
| `aliyun_kms` | Alibaba Cloud KMS |

Every `*_ref` in connector / blob / model config resolves here.

## 15. Realtime (in-app)

WebSocket or SSE on Nest. Anything that should hit the OS tray / lock screen
goes through `Notifier`.

## 16. Ports at a glance

| Port | Swappable | Must stay the same |
| --- | --- | --- |
| `AuthorityStore` | SQLite / PostgreSQL | domain tables and query semantics |
| `JobQueue` | in-process / BullMQ | job types and idempotency keys |
| `BlobStore` | fs / MinIO / S3 / OSS | `content_hash` addressing |
| `ChannelConnector` | Feishu / WeCom / Slack / email / … | writes Event + Blob |
| `ModelProvider` | OpenAI / Azure / 通义 / vLLM / none | complete / embed |
| `IdentityProvider` | local / OIDC / Feishu SSO / … | Principal mapping (RFC 0006) |
| `SearchIndex` | noop / sqlite_fts / pgvector / … | visibility-filtered query |
| `Notifier` | Electron / APNs / FCM / … | notification event shape |
| `SecretStore` | keychain / file / env / Vault / … | `credentials_ref` resolution |
