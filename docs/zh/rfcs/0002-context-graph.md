# RFC 0002 — 上下文图谱

- **状态：** Accepted
- **English:** [../../en/rfcs/0002-context-graph.md](../../en/rfcs/0002-context-graph.md)
- **依赖：** RFC 0001（用于链接的标准身份）
- **相关：** RFC 0003（协作）、RFC 0004（API）
- **方法论：** 《重写基因》第 9 章（共识机器 / 统一上下文）

## 1. 问题

今日决策上下文活在各团队聊天孤岛里。两个凡人与一个 Agent 做「同一」决策时，
往往看到不同事实，无法重放当时所见，也无法区分事实与假设。统一上下文不是
「透明一切」；它是**同一决策的同一事实集**，带出处与访问边界。

## 2. 目标

1. 将组织上下文表示为实体、claim 与关系的**图谱** — 而非仅文档文件夹。
2. 提供绑定到决策与 agent run 的**不可变 snapshot**。
3. 区分 **fact / hypothesis / opinion**。
4. 按**决策需要与 scope** 强制访问，而非按聊天成员资格。
5. 当实质上下文变更时触发**标准复审**（与 RFC 0001 同步）。

## 3. 非目标

- 替换文档编辑器或文件存储厂商。
- 全公司社交透明或动态信息流。
- 实时 CRDT 同步语义（v1 对 claim 的最终一致即可）。

## 4. 核心类型

### 4.1 `Entity`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | |
| `kind` | enum | `person` \| `agent` \| `team` \| `customer` \| `product` \| `standard` \| `decision` \| `evidence` \| `document` \| `metric` \| `other` |
| `name` | string | |
| `attrs` | object | 按 kind 校验的特有 schema |
| `org_id` | string | |
| `created_at` | datetime | |
| `created_by` | `ActorRef` | |

`standard` 实体引用 RFC 0001 的 `standard_id`；不复制标准正文。

### 4.2 `Claim`

关于世界的类型化断言，带出处。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | |
| `subject_entity_id` | string | |
| `predicate` | string | 优先受控词表 |
| `object` | string \| number \| boolean \| object \| `entity_ref` | |
| `claim_type` | enum | `fact` \| `hypothesis` \| `opinion` |
| `confidence` | number \| null | 可选 0–1 |
| `valid_from` | datetime \| null | |
| `valid_to` | datetime \| null | 软有效窗 |
| `provenance` | `Provenance` | 必需 |
| `access` | `AccessPolicy` | 必需 |
| `status` | enum | `active` \| `superseded` \| `retracted` |
| `superseded_by` | string \| null | |

**规则：**

- `hypothesis` 在可喂给标准晋升（RFC 0001 闸门 4）之前，**必须**包含
  `validation_window`（在 `attrs` 或 `valid_to` 中）。
- `opinion` **不得**在未转换为带新出处的 fact/hypothesis 前，当作
  trial→active 的证据。
- 撤回 claim 不改写历史；snapshot 保留旧 claim id。

### 4.3 `Edge`

| 字段 | 类型 |
| --- | --- |
| `id` | string |
| `from_entity_id` | string |
| `to_entity_id` | string |
| `rel_type` | string | 例如 `member_of`、`owns`、`depends_on`、`cites`、`evidences` |
| `provenance` | `Provenance` |
| `access` | `AccessPolicy` |

### 4.4 `Provenance`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `source_kind` | enum | `human_input` \| `agent_observation` \| `system_import` \| `document` \| `metric_pipeline` \| `decision` \| `review` |
| `source_ref` | string | 外部或内部 id |
| `recorded_by` | `ActorRef` | |
| `recorded_at` | datetime | |
| `raw_excerpt` | string \| null | 可选摘录 / 指针 |
| `uri` | string \| null | 可用时的稳定链接 |

### 4.5 `AccessPolicy`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `visibility` | enum | `decision_scoped` \| `team` \| `org` \| `restricted` |
| `principal_ids` | string[] | 允许的人/agent/团队 |
| `decision_kinds` | string[] | 若为 `decision_scoped`，哪些 kind 可包含此 claim |
| `deny_exfiltrate` | boolean | 若为 true，claim 可出现在 UI，但未经升权不得进入 agent 导出 bundle |

默认：**decision-scoped**。薪酬、合规红线与未官宣并购保持 `restricted`，
永不进入通用「org」bundle。

### 4.6 `ContextSnapshot`

为决策或 agent run 准备的图谱不可变切片。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | |
| `org_id` | string | |
| `decision_kind` | string | |
| `purpose` | string | 为何构建此 snapshot |
| `entity_ids` | string[] | 包含的实体 |
| `claim_ids` | string[] | 包含的 claim（钉死） |
| `edge_ids` | string[] | 包含的边 |
| `standard_bindings` | `StandardBinding[]` | 适用标准（RFC 0001） |
| `built_for_principals` | `ActorRef[]` | 获授权看到此切片的主体 |
| `content_hash` | string | 对排序后的 claim/edge id + 正文的哈希 |
| `created_at` | datetime | |
| `created_by` | `ActorRef` | |

### 4.7 `ContextBundle`

面向 API 的 snapshot 投影（人机 UI 或 agent）。

| 字段 | 类型 |
| --- | --- |
| `snapshot_id` | string |
| `principal` | `ActorRef` |
| `claims` | Claim[] | 按访问过滤 |
| `entities` | Entity[] | |
| `edges` | Edge[] | |
| `standards` | 解析后的 StandardVersion 摘要 |
| `redactions` | string[] | 因策略省略的 claim id（仅 id，无正文） |

两位具有相同决策角色与策略的 principal **必须**收到可见 claim 的
`content_hash` 相同的 bundle。哈希不一致是产品缺陷。

### 4.8 `StandardBinding`

| 字段 | 类型 |
| --- | --- |
| `standard_id` | string |
| `standard_version_id` | string |
| `reason` | string | 为何纳入此 snapshot |

### 4.9 `ContextChangeEvent`

| 字段 | 类型 |
| --- | --- |
| `id` | string |
| `claim_or_edge_id` | string |
| `change` | enum | `created` \| `superseded` \| `retracted` |
| `materiality` | enum | `low` \| `high` |
| `suggested_standard_ids` | string[] | 应复审的标准 |
| `created_at` | datetime | |

当存在关联标准时，`materiality = high` **应当**打开或更新复盘 Proposal（RFC 0003）。

## 5. 一致性规则

1. **同一决策，同一事实集：** 对给定
   `(org_id, decision_kind, purpose, principal_set)` 的 snapshot 构建者使用
   确定性选择算法（见实现说明）。任一参与者临时塞 claim 而没有新
   snapshot id 是禁止的。
2. **重放：** 任一 Decision 或 AgentRun 存储 `context_snapshot_id`，并能
   重新水合精确 claim 集。
3. **无静默突变：** 编辑 claim 会创建新 claim 并将旧的标为 `superseded`；
   snapshot 永不突变。
4. **假设隔离：** hypothesis 在 bundle 中须如此标注；晋升到标准的路径需要
   验证证据。

## 6. 验收标准（Phase 2 退出）

两个团队与一个 Agent 能为同一决策共享同一上下文 snapshot，而无需从 Slack
复制粘贴。越权内容不可见，且不污染决策哈希。

## 7. 已裁定（#2 — 已批准）

- [x] **`predicate` / `rel_type` 词表推迟到实现。** Phase 2 先用文档化 allow-list，后续再扩；本 RFC 不冻结完整词表治理流程。
- [x] **文档既是实体也是出处。** v1 同时保留 `document` 实体与 provenance 指针，不只做其中一种。
