# RFC 0007 — 日蒸馏

- **状态：** Draft
- **English:** [../../en/rfcs/0007-daily-distillation.md](../../en/rfcs/0007-daily-distillation.md)
- **依赖：** RFC 0005（Event/Digest/Blob）、RFC 0006（ACL）、RFC 0001（标准）、RFC 0003（提案）
- **相关：** RFC 0002（可选 Claim 提升）
- **方法论：** 《重写基因》第 6 章标准机器进料；第 9 章复盘车间

## 1. 问题

原始 Event 极多；判断资产稀缺。Regenic 必须对每日运转上下文**过滤并加权**，
产出可进入标准机器的一小批类型化条目 — 且不升权、不做「日报文学」。

## 2. 目标

1. 每个 org-日 × `direction`，产出 ≤N 条带证据的类型化 item。
2. 模型可以**提案**；代码拥有分数、冲突、ACL、配额。
3. 输出是标准机器进料（`item_kind`），不是聊天摘要。
4. 先交付 **D0**（纯规则、无 LLM），再 D1（LLM 提案）。

## 3. 非目标

- 完整 NLP 主题模型研究。
- 自动激活标准（需要人审 accept）。
- 把蒸馏当作全组织越权读数后门。

## 4. Direction（受控）

`product` | `sales` | `customer` | `org` | `finance` | `risk`

`finance` / `risk` 可按 org 关闭。自由标签不是分区键。

## 5. Item 类型

| `item_kind` | 下游 |
| --- | --- |
| `new_judgment` | Standard draft 候选 |
| `standard_amendment` | StandardVersion draft（RFC 0001） |
| `hypothesis` | 复盘回路（RFC 0003） |
| `bad_news` | 优先呈现 + 延长保活 |
| `metric_signal` | 需要 evidence_class ≥ metric |
| `clarify_request` | `needs_clarify`；永不自动 accept |

## 6. 流水线

```
Fetch C (ACL-visible Events in period) + A (active standards, recent digests)
→ Normalize/dedupe (content_hash, thread fold)
→ Direction route
→ Cluster (D0: thread_id / channel; D1+: embeddings optional)
→ Propose items (D0: rules; D1: LLM → JSON)
→ Score + conflict (deterministic)
→ Top-N + bad_news seat
→ Derive required_scope_ids
→ Write Digest + Evidence (proposed)
→ Notify direction owners (ACL-safe)
```

Job principal：`service` + `can_propose_digest`（RFC 0006）。

## 7. 打分（V1 表，可配置）

```
base = role_tier × evidence_class × recency × source_trust × direction_fit
item.score = Σ(weight_e) × novelty × actionability
```

建议标量：

| 因子 | 示例 |
| --- | --- |
| `role_tier` | CEO 5.0；direction lead 3.5；owner 2.0；member 1.0；agent 0.8 |
| `evidence_class` | metric 4；demo 3；user_verbatim 2.5；decision_record 2.5；opinion 1 |
| `source_trust` | regenic 决策线程 1.2；ticket/cs 1.1；chat 0.7 |
| `recency` | 日内 1.0；积压 ×0.9^days |

配额：每 direction 每日 ≤7 条 item；有候选时 ≥1 个 `bad_news` 席位；
每 item 1–12 条证据行；body ≤800 字符。

## 8. 冲突

| 类型 | 处理 |
| --- | --- |
| `role_vs_evidence` | 产出 `clarify_request`；两侧都保留为证据 |
| `standard_vs_reality` | `standard_amendment` 或 `hypothesis` |
| `authority_split` | `clarify_request`；通知双方 admin |
| `acl_split` | 脱敏 digest 或拆分 digest — 永不改宽 |

## 9. 输出 schema（`schema_version: "1.0"`）

见设计讨论 §8；规范性字段：

- JobRun：`org_id`, `period_start/end`, `job_principal_id`, `directions[]`
- Direction：`direction`, `digest_id`, `status`, `required_scope_ids`, `items[]`, `stats`
- Item：`item_kind`, `title`, `body`, `score`, `evidence[]`, `conflicts[]`, `linked_standard_id?`
- Evidence：`event_id`, `weight_applied`, `reason`, `span?`

映射到 RFC 0005 表。对人 **accept** 的 `standard_amendment` /
`new_judgment`，打开 RFC 0003 Proposal（agent 仍不能激活）。

## 10. 阶段

| 阶段 | 交付 |
| --- | --- |
| **D0** | 纯规则 — 高权重 / bad-news / metric 骨架（本 RFC §11 + sketch SQL） |
| D1 | LLM 提案 + 代码终裁 |
| D2 | 联动 Standard draft |
| D3 | 脱敏 digest；跨 direction 去重 |
| D4 | 覆盖率 / orphan_high_weight 报警 |

## 11. D0 算法（规范性草图）

无 LLM。对每个 direction 桶：

1. 选择候选 Event：period ∩ `visible(job)` ∩ 非 tombstone。
2. 用 `weight_hints` + membership role_tier 表计算 `base` 分。
3. 线程折叠：每个 `thread_id` 保留最高分 Event（null thread → 按 event）。
4. 分类：
   - `weight_hints.evidence_class = metric` → `metric_signal`
   - preview/attrs 匹配 bad-news 词表，或 `attrs.severity >= high` → `bad_news`
   - `role_tier >= 3.5` → `hypothesis`（title = preview 截断）
   - 否则丢弃（D0 不产出低信号闲聊）
5. 冲突：若两条保留 item 的 `attrs.stance` 相反且二者
   `role_tier >= 3.5` → 替换为一条引用双方的 `clarify_request`。
6. 应用 Top-N + bad_news 席位；派生 `required_scope_ids`；插入 Digest。

伪代码 / SQL：[`../../en/rfcs/sketch/d0-daily-distill.sql`](../../en/rfcs/sketch/d0-daily-distill.sql)。

## 12. 验收标准

1. 在 fixture 数据上跑 D0，产出带证据且 `required_scope_ids` 正确的 Digest。
2. 缺少任一证据 scope 的 principal 不能读取严格 Digest body。
3. 同一 period 重跑对 `proposed` 幂等（supersede 旧 proposed；
   永不改动 `accepted`）。

## 13. 待决问题

- `period_*` 使用 org 本地时区。
- 超大 org 的 per-unit 子配额。
- D0 bad-news 词表来源（org 可配置列表）。
