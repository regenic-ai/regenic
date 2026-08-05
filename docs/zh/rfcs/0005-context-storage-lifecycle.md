# RFC 0005 — 上下文存储与生命周期

- **状态：** Draft
- **English:** [../../en/rfcs/0005-context-storage-lifecycle.md](../../en/rfcs/0005-context-storage-lifecycle.md)
- **依赖：** RFC 0002（上下文图谱语义）、RFC 0001（标准身份）
- **相关：** RFC 0006（ACL）、RFC 0007（日蒸馏）
- **方法论：** 《重写基因》第 6 章（标准机器进料）、第 9 章（统一上下文 ≠ 全量热存）

## 1. 问题

RFC 0002 定义了**逻辑**上下文图谱（Entity / Claim / Snapshot）。
在产品规模下，原始运转上下文（IM、工单、客服、Agent 轮次）可能无限增长。
若原文进入热图谱存储，私有化部署成本与检索质量都会垮掉。

本 RFC 定义图谱之下的**物理层**：存什么、存哪里、如何控制体积，
以及蒸馏产物如何保持小体积且可审计。

## 2. 目标

1. 将**字节**（Blob）、**瘦事件**（Event）、**蒸馏产物**（Digest）与
   **标准**（RFC 0001）分成不同的耐久等级。
2. 使热库体积大致为 **O(蒸馏产物 + 热窗口元数据 + 现行标准)**，
   而非 O(全历史聊天)。
3. 保证**溯源**：任一已接受的 Digest / StandardVersion 能指向证据 Event；
   被引用的 blob 对 GC 免疫。
4. 利于私有化部署：默认技术栈为 Postgres + 对象存储。

## 3. 非目标

- 选定具体 LLM 或 embedding 供应商。
- 完整 IM 产品体验（沟通壳可后置；本 RFC 只谈存储）。
- 替换 RFC 0002 的 Claim/Snapshot 语义 — Event **喂给** Claim；它们不取代 Claim。

## 4. 分层图

| 层 | 存放 | 存储 | 寿命 |
| --- | --- | --- | --- |
| L0 Blob | 原文字节（消息正文、附件、转写） | 对象存储（MinIO/S3）+ zstd | 按 GC 策略 |
| L1 Event | 瘦运营原子 + 指针 | PostgreSQL（按时间分区） | 元数据长留；正文经 L0 |
| L2 Index | 热窗检索 / 可选向量 | pgvector 或 OpenSearch | 仅热窗 |
| L3 Digest | 线程 / 日方向蒸馏物 | PostgreSQL | 长留；体积小 |
| L4 Standard | RFC 0001 版本 | PostgreSQL | 永久 |
| L5 Graph | Claim / Entity / Snapshot（RFC 0002） | PostgreSQL | 永久 / 被取代链 |

超大规模可选：ClickHouse（或对象存储上的 Parquet）作为 Event 行的
**分析副本** — 绝非 ACL 权威源。

## 5. 核心类型（物理）

### 5.1 `Blob`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `content_hash` | string | PK；规范字节的 sha256 |
| `storage_uri` | string | 对象键 |
| `codec` | enum | `raw` \| `zstd` |
| `media_type` | string | |
| `byte_size` | int | 未压缩 |
| `stored_size` | int | 落盘大小 |
| `created_at` | datetime | |
| `ref_count` | int | 维护或重算 |

相同内容只存一份。Blob **没有**独立 ACL；访问始终经由 Event 或 Digest
（`via_event_id` / `via_digest_id`）。

### 5.2 `Event`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 内部主键 |
| `org_id` | string | |
| `source` | enum | `regenic` \| `feishu` \| `wecom` \| `slack` \| `ticket` \| `cs` \| … |
| `external_id` | string | 幂等：`(org_id, source, external_id)` 唯一 |
| `type` | enum | `message` \| `thread_reply` \| `ticket_update` \| `decision` \| `agent_turn` \| … |
| `channel_id` | string | |
| `thread_id` | string \| null | |
| `parent_event_id` | string \| null | |
| `actor_id` | string | Principal id（RFC 0006） |
| `actor_kind` | enum | `human` \| `agent` \| `system` |
| `ts` | datetime | 优先源时间 |
| `ingested_at` | datetime | |
| `content_hash` | string | FK → Blob |
| `text_preview` | string \| null | ≤280 字符；敏感级同正文 |
| `acl_scope_id` | string | RFC 0006 |
| `direction_tags` | string[] | 可选粗标签 |
| `weight_hints` | object \| null | `{role_tier, evidence_class, source_trust}` |
| `attrs` | object | 源特有；**禁止**长正文 |
| `tombstone` | boolean | 源侧撤回 / 删除 |
| `claim_id` | string \| null | 可选提升链接到 RFC 0002 |

索引：`(org_id, ts DESC)`、`(org_id, channel_id, ts)`、`(content_hash)`。
按 `ts` 分区（月/季）。

### 5.3 `Digest`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | |
| `org_id` | string | |
| `kind` | enum | `thread_summary` \| `daily_direction` \| … |
| `direction` | string | 受控词表（RFC 0007） |
| `period_start` / `period_end` | datetime | |
| `title` | string | |
| `body_hash` | string | FK → Blob（或短 inline `body_text`） |
| `acl_scope_id` | string | |
| `required_scope_ids` | string[] | 由证据派生；Job 不可改宽 |
| `score` | number | |
| `status` | enum | `proposed` \| `accepted` \| `rejected` \| `needs_clarify` \| `superseded` |
| `created_by` | string | Job 或人类 principal |
| `supersedes_id` | string \| null | |

### 5.4 `DigestEvidence`

| 字段 | 类型 |
| --- | --- |
| `digest_id` | string |
| `event_id` | string |
| `weight_applied` | number |
| `reason` | string |
| `span` | object \| null | 可选：blob 内偏移 |

**规则：** `accepted` 的 Digest **必须**有 ≥1 条证据行。

### 5.5 与 RFC 0002 的桥

已接受的 Digest / 高信号 Event **可以**铸造或更新：

- `Claim`，且 `provenance.source_kind = system_import | agent_observation`
- `Provenance.source_ref = event_id` 或 `digest_id`
- 决策用的 `ContextSnapshot` 仍钉住 **claim id**，而非原始 event 洪流

Agent 与人主要在 **Standards + Snapshots + Digests** 上推理，
按需拉取 Event。

## 6. 降容结构

1. **内容寻址去重** — 每 hash 一个 Blob。
2. **正文离开 Postgres** — 仅瘦 Event 行。
3. **分层蒸馏** — Event → 线程 Digest → 日 Digest → Standard。
4. **向量建在蒸馏物上**（及可选热窗子集体），而非全历史聊天。
5. **引用保活 GC** — 见 §7。

## 7. GC 规则

### 7.1 硬保活

若被以下任一引用，Blob/Event 元数据**不得**硬删除：

1. 任一未删除的 `DigestEvidence`
2. 任一 `StandardVersion` 源链接
3. 任一 RFC 0003 Decision / Proposal 证据引用
4. 配置的高权重保留（例如窗口内的 CEO 决策类）
5. 合规 hold / break-glass 访问（RFC 0006）

### 7.2 默认寿命（可按 org 配置）

| 对象 | 默认 |
| --- | --- |
| 未引用 Event 正文 | 可检索 30 天；冷存 90 天；可删 180 天 |
| Event 瘦行 | ≥180 天后归档分区 |
| 线程 Digest | 1 年，或直至被吸收并 superseded |
| 驱动过 Standard 的已接受日 Digest | 更长 / 永久指针 |
| StandardVersion | 永久 |
| 向量行 | 随对象寿命 |

### 7.3 Job 顺序

```
recount refs → candidate expired∧unreferenced∧no hold
→ drop vectors → delete blob → archive/drop event partition
→ write gc_audit
```

### 7.4 护栏指标

- `hot_pg_bytes` / org
- `blob_bytes_unreferenced`
- `digest_accept_rate`
- `events_with_digest_coverage`

存储上升而覆盖率持平 ⇒ 蒸馏没在工作；不要只扩磁盘。

## 8. 验收标准

1. 接入 100 万条 Event 而不在 Postgres 中存储正文。
2. 在策略窗口后删除未引用 blob，且不破坏已接受 Digest 的溯源。
3. Snapshot/决策路径默认从不需要加载全频道历史。

## 9. 待决问题

- 按日分区用 org 时区还是 UTC。
- body GC 后 `text_preview` 是否作为审计粉尘保留。
- 多租户分区键优先：`org_id` 还是 `ts`。
