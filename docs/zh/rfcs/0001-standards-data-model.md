# RFC 0001 — 标准数据模型

- **状态：** Accepted
- **English:** [../../en/rfcs/0001-standards-data-model.md](../../en/rfcs/0001-standards-data-model.md)
- **依赖：** —
- **相关：** RFC 0002（上下文）、RFC 0003（协作）、RFC 0004（API）
- **方法论：** 《重写基因》第 6 章（标准机器）、公开标准
  `product-iteration-standard`、standards README（condition / action /
  acceptance / boundary / revision trigger）

## 1. 问题

组织把判断存成口口相传、聊天线程或静态 SOP 墙。人与 Agent 无法引用同一
可版本产物，无法在全员采用前做金丝雀，也无法证明一轮迭代学到了任何东西
（修订或新标准）。

## 2. 目标

1. 将**判断标准**编码为版本化、可引用、人与 Agent 共用的对象。
2. 支持**渐进生命周期**：draft → trial → active → deprecated。
3. 把书中的**五迭代闸门**落实为可机检字段，而非散文愿望。
4. 干净映射到 `regenic-book` 中的公开 markdown 标准。

## 3. 非目标

- 会议工作流/UI（RFC 0003）。
- 上下文图谱存储（RFC 0002）。
- Agent 运行时或 LLM prompt（RFC 0004 只定义 API 协议）。

## 4. 核心类型

### 4.1 `Standard`

跨版本的稳定身份。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string (ULID/UUID) | 不可变 |
| `slug` | string | 组织内唯一、URL 安全 |
| `title` | string | 人类标签 |
| `layer` | enum | `stable_core` \| `adjacent` \| `frontier` |
| `scope` | `Scope` | 适用于谁/什么 |
| `created_at` | datetime | |
| `created_by` | `ActorRef` | 人或系统 |
| `current_version_id` | string \| null | 指向最新非 draft（若有） |
| `citation_count` | integer | 滚动健康指标；优于「有多少条标准」 |

### 4.2 `StandardVersion`

离开 `draft` 后不可变（不改变含义的元数据除外）。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | |
| `standard_id` | string | |
| `version` | semver string | 例如 `1.2.0` |
| `status` | enum | `draft` \| `trial` \| `active` \| `deprecated` |
| `condition` | markdown/string | 何时适用 |
| `action` | markdown/string | 期望的判断或行为 |
| `acceptance` | markdown/string | 成功的可观察证据 |
| `boundary` | markdown/string | 何时停止或升级 |
| `revision_trigger` | markdown/string | 强制变更的证据 |
| `gate` | `IterationGate` | `trial` 与 `active` 时必需 |
| `trial` | `TrialConfig` \| null | `status = trial` 时必需 |
| `supersedes_version_id` | string \| null | 上一版本 |
| `body_hash` | string | 内容寻址完整性 |
| `published_at` | datetime \| null | |
| `published_by` | `ActorRef` \| null | |

### 4.3 `Scope`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `org_id` | string | |
| `team_ids` | string[] | 空 = 全组织 |
| `roles` | string[] | 可选角色过滤 |
| `decision_kinds` | string[] | 例如 `pricing`、`hiring`、`release` |

### 4.4 `IterationGate`

`product-iteration-standard` 中五闸门的产品化。

| 字段 | 类型 | 闸门 |
| --- | --- | --- |
| `single_uncertainty` | string | **1** — 本次变更验证的那一个不确定性 |
| `target_user_tier` | enum | innovator / early_adopter / early_majority / late_majority / laggard |
| `consensus_hypothesis` | string | 假定的用户共识 |
| `value_metric` | string | 如何度量成功 |
| `cost_budget` | string | 精力 / 金钱上限 |
| `validation_window` | duration 或日期范围 | |
| `stop_condition` | string | 何时中止 |
| `stable_core_preserved` | boolean | **2** — 非 frontier 离开 draft 必须为 true |
| `compat_and_rollback` | string | **3** — 迁移 + 回滚计划 |
| `upgrade_evidence` | `UpgradeEvidence` \| null | **4** — trial → active 晋升必需 |
| `learning_output` | enum | **5** — `new_standard` \| `revision` \| `no_standard_needed` |

### 4.5 `UpgradeEvidence`

晋升到 `active` 时全部必须为真（或以已审计的 `waiver_reason` 显式豁免）：

| 字段 | 类型 |
| --- | --- |
| `core_value_revalidated` | boolean |
| `delivery_standardized` | boolean |
| `unit_economics_or_roi_ok` | boolean |
| `next_tier_behavioral_evidence` | boolean |
| `rollback_safe` | boolean |
| `waiver_reason` | string \| null |

### 4.6 `TrialConfig`（金丝雀）

| 字段 | 类型 |
| --- | --- |
| `audience` | `Scope` | 窄于父 scope |
| `starts_at` | datetime |
| `ends_at` | datetime \| null |
| `success_metric` | string |
| `stop_condition` | string |

### 4.7 `ActorRef`

| 字段 | 类型 |
| --- | --- |
| `actor_type` | enum | `human` \| `agent` \| `system` |
| `actor_id` | string |

### 4.8 `StandardGap`（渐进式生成的进料口）

来自执行失败、例外、每日三问输出或复盘（RFC 0003）。

| 字段 | 类型 |
| --- | --- |
| `id` | string |
| `summary` | string |
| `source_kind` | enum | `execution_failure` \| `exception` \| `three_questions` \| `review` \| `manual` |
| `source_ref` | string | decision / run / review 的 ID |
| `proposed_uncertainty` | string |
| `status` | enum | `open` \| `converted` \| `dismissed` |
| `converted_proposal_id` | string \| null | RFC 0003 |

## 5. 生命周期规则

```text
draft ──publish_trial──► trial ──promote──► active ──deprecate──► deprecated
  │                        │
  └────────publish_active──┘   (only if UpgradeEvidence complete; rare fast-path)
```

1. **单变量规则：** 在 `gate` 中一次变更超过一项
   `{target_user_tier, decision_kind scope, commercial model, core tech
   assumption}` 的版本**必须**保持 `draft`，直至拆分或豁免。
2. **引用：** 应用（RFC 0004）**必须**绑定 `standard_id` +
   `version`（或 `standard_version_id`）。浮动「latest」仅允许作为解析时便利；
   存储绑定始终钉死。
3. **废弃：** `active` → `deprecated` 需要 `revision_trigger` 证据或显式取代版本。
4. **健康：** 在可配置窗口内 `citation_count = 0` 的标准应浮现为废弃或合并候选 —
   条数不是 KPI。

## 6. 渐进式生成流

1. 发现缺口 → `StandardGap`
2. 打开 Proposal（RFC 0003），恰好一个 `single_uncertainty`
3. 撰写 `draft` 状态的 `StandardVersion`
4. 带 `TrialConfig` 进入 `trial`
5. 闸门 4 证据齐 → `active`
6. 每轮关闭的迭代**必须**设置 `learning_output`（闸门 5）

## 7. 映射到公开 markdown

| Markdown 节 | 字段 |
| --- | --- |
| Condition | `condition` |
| Action | `action` |
| Acceptance | `acceptance` |
| Boundary | `boundary` |
| Revision trigger | `revision_trigger` |

导入/导出应把这五节作为一等字段保留，可选扩展 markdown 正文承载叙事。

## 8. 验收标准（Phase 1 退出）

一个团队能发布、应用并修订一条组织级标准，而不必为每个团队另开聊天线程。
Agent 与人引用同一 `standard_version_id`。

## 9. 待决问题

Wave A 评审裁定或推迟（Issues #1 / #8 — 已批准）：

| 议题 | 裁定 | 状态 |
| --- | --- | --- |
| Book 闸门编号 vs 产品五闸门 | 保留产品五闸门；book 规则为解说 + 分段枚举 | 已确认 |
| `UpgradeEvidence` vs book 标题 | 产品化；不要求 1:1 book 标题 | 已确认 |
| `layer` 枚举 | 仅产品侧；不来自公开 book markdown | 已确认 |
| 组织私有标准 semver vs 单调整数 | **推迟到 Phase 1 实现** — 默认 semver 字符串；必要时再迁 | 已推迟 |
| `layer` 是否可不发新版本而变更 | **否** — 变更 `layer` 须新 `StandardVersion` | 已确认 |
