# RFC 0003 — 协作对象

- **状态：** Draft
- **English:** [../../en/rfcs/0003-collaboration-objects.md](../../en/rfcs/0003-collaboration-objects.md)
- **依赖：** RFC 0001（标准）、RFC 0002（上下文 snapshot）
- **相关：** RFC 0004（API）
- **方法论：** 《重写基因》第 9 章（会议 / 文档 / 复盘车间）、
  第 10 章（决策权阶梯）

## 1. 问题

今日人类协作与人机交接发生在聊天里。聊天优化的是消息，不是判断产物。
Regenic 需要共享对象，其**唯一合法出口**是：新/修订标准、在上下文
snapshot 下记录的决策，或被验证/证伪的假设 — 绝非无界线程。

## 2. 目标

1. 产品化三个车间：**会议（决策场）**、**文档（可引用上下文/标准正文）**、
   **复盘（反馈回路）**。
2. 将 **Proposal**、**Decision**、**Review**、**Handoff** 定义为人与 Agent
   可用的一等对象。
3. 使**决策权阶梯**在每个协作对象上可见。
4. 将**坏消息 / 偏差报告**作为一等公民，而非评论旁路。

## 3. 非目标

- 聊天产品或实时消息。
- 通用任务/工单追踪器。
- 日历/视频会议集成（Phase 3 适配器）。

## 4. 共享枚举

### 4.1 `DecisionRightsLevel`

| 值 | 含义 |
| --- | --- |
| `direct` | 管理者决定；成员执行 |
| `coach` | 管理者示范如何做判断 |
| `negotiate` | 共同选择；共同承诺 |
| `authorize` | 成员在固定边界内决定 |
| `delegate` | 成员也可优化边界 |

### 4.2 `EvidenceKind`

对齐「没有可运行的 DEMO，不上会」：

| 值 | 说明 |
| --- | --- |
| `data` | 指标、表格、查询 |
| `demo` | 可运行产物 / URL / 运行录像 |
| `user_quote` | 用户原话 |
| `document` | 可引用文档实体（RFC 0002） |
| `other` | 需要正当理由；不鼓励 |

没有上述之一的纯观点**不得**把 Proposal 推进到 `submitted` 之后。

## 5. 核心类型

### 5.1 `Proposal`

某人（人或 agent）提议变更标准、上下文，或在既有标准下做决策。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | |
| `kind` | enum | `new_standard` \| `revise_standard` \| `decision` \| `context_update` \| `hypothesis` |
| `title` | string | |
| `summary` | string | |
| `status` | enum | `draft` \| `submitted` \| `in_review` \| `accepted` \| `rejected` \| `withdrawn` |
| `author` | `ActorRef` | |
| `rights_level` | `DecisionRightsLevel` | 本提案所处处理层级 |
| `boundary` | string | 决策范围内外 |
| `context_snapshot_id` | string \| null | `decision` / 标准类在 `submitted` 前必需 |
| `standard_bindings` | `StandardBinding[]` | 生效或变更中的标准 |
| `single_uncertainty` | string \| null | 标准类必需（RFC 0001 闸门 1） |
| `evidence` | `EvidenceRef[]` | 提交时至少一个非 `other` |
| `gap_id` | string \| null | 链接到 `StandardGap` |
| `outcome_ref` | `OutcomeRef` \| null | accept 时设置 |
| `created_at` | datetime | |
| `updated_at` | datetime | |

### 5.2 `EvidenceRef`

| 字段 | 类型 |
| --- | --- |
| `kind` | `EvidenceKind` |
| `uri_or_ref` | string |
| `note` | string \| null |
| `claim_ids` | string[] | 可选链入上下文图谱 |

### 5.3 `OutcomeRef`

| 字段 | 类型 |
| --- | --- |
| `outcome_kind` | enum | `standard_version` \| `decision` \| `claim` \| `none` |
| `ref_id` | string \| null | |

`learning_output = no_standard_needed` 映射为 `outcome_kind = none`，并在
Proposal 上保留已审计原因。

### 5.4 `Decision`

在钉死的标准 + 上下文下记录的判断。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | |
| `proposal_id` | string \| null | |
| `summary` | string | 决定了什么 |
| `rationale` | string | |
| `decided_by` | `ActorRef` | |
| `rights_level` | `DecisionRightsLevel` | |
| `context_snapshot_id` | string | 必需 |
| `standard_bindings` | `StandardBinding[]` | 运营决策必需且非空 |
| `status` | enum | `committed` \| `superseded` \| `void` |
| `committed_at` | datetime | |

### 5.5 `Review`

反馈回路：验证或证伪标准 / 假设 / 决策。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | |
| `subject_kind` | enum | `standard_version` \| `decision` \| `hypothesis_claim` \| `agent_run` |
| `subject_id` | string | |
| `result` | enum | `validated` \| `falsified` \| `inconclusive` |
| `severity` | enum | `normal` \| `bad_news` | `bad_news` 为一等 |
| `evidence` | `EvidenceRef[]` | |
| `context_snapshot_id` | string \| null | 复盘时使用的 snapshot |
| `recommended_action` | enum | `solidify` \| `revise_standard` \| `open_gap` \| `none` |
| `author` | `ActorRef` | |
| `created_at` | datetime | |

`result = falsified` 且 `recommended_action = revise_standard` **应当**打开
`Proposal(kind=revise_standard)` 或 `StandardGap`。

### 5.6 `Handoff`

显式的人 ↔ agent 移交。不是聊天私信。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | |
| `direction` | enum | `agent_to_human` \| `human_to_agent` |
| `from` | `ActorRef` | |
| `to` | `ActorRef` | |
| `reason` | `HandoffReason` | |
| `proposal_id` | string \| null | |
| `decision_id` | string \| null | |
| `agent_run_id` | string \| null | RFC 0004 |
| `context_snapshot_id` | string | |
| `standard_bindings` | `StandardBinding[]` | |
| `payload` | object | 结构化请求/结果；按 reason 定 schema |
| `status` | enum | `open` \| `acked` \| `resolved` \| `cancelled` |
| `created_at` | datetime | |
| `resolved_at` | datetime \| null | |

### 5.7 `HandoffReason`

**Agent → Human**

| 值 | 何时 |
| --- | --- |
| `standard_uncovered` | 无适用标准 / 撞到边界 |
| `evidence_conflict` | snapshot 内 claim 不一致 |
| `permission_denied` | 访问策略挡住所需 claim |
| `acceptance_failed` | 输出未通过标准 acceptance |
| `escalation_boundary` | 标准要求人类判断 |

**Human → Agent**

| 值 | 何时 |
| --- | --- |
| `approve_proposal` | 执行已接受提案 |
| `revise_standard` | 应用新版本后继续 |
| `enrich_context` | 用新增 claim 重建 snapshot |
| `set_boundary` | 在显式边界内执行 |
| `retry_with_binding` | 用钉死的标准版本重跑 |

## 6. 车间映射

| 车间 | 主要对象 | 硬出口 |
| --- | --- | --- |
| 会议 / 决策场 | `Proposal` → `Decision` | 新/修订标准、决策或假设 claim |
| 文档 | 上下文 `Claim`/`Entity`、`StandardVersion` 正文 | 仅可引用 id；口头不算 |
| 复盘 | `Review` → 可选 `Proposal` / `StandardGap` | 验证 / 证伪 / 修订 |

未产出任一出口的场次是失败场次（产品应暴露这一点，而非把聊天归档自动当作成功）。

## 7. 漂移信号

当观察到的行为（agent run + 人类决策）偏离所引用
`StandardVersion.action` / `acceptance` 时，系统打开 `Review`；acceptance
反复失败时提升 `severity`。这是「声称的标准 vs 观察到的行为」的产品钩子。

## 8. 验收标准

两个人能在一个 snapshot 上将 Proposal 推进到 Decision，而无需私下对齐聊天。
一个人与一个 agent 能仅用 `Handoff` 对象完成
Proposal → 绑定标准 → 执行 → Review → 修订。

## 9. 待决问题

- `negotiate` 是否需要双方 `decided_by` 签名（提案：是，
  `co_deciders: ActorRef[]`）。
- 每种 Proposal kind 的最低证据数。
