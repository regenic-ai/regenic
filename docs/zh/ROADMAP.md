# 路线图

[English](../en/ROADMAP.md)

Regenic 分层交付。每一层须可独立使用后再开下一层——与《重写基因》中的渐进式迭代闸门一致。

## Phase 0 — 架构（当前）

- [x] RFC：标准数据模型（定义、范围、版本、生命周期）—
  [中文](rfcs/0001-standards-data-model.md) / [EN](../en/rfcs/0001-standards-data-model.md)
- [x] RFC：上下文图谱（实体、关系、出处、访问）—
  [中文](rfcs/0002-context-graph.md) / [EN](../en/rfcs/0002-context-graph.md)
- [x] RFC：协作对象（Proposal / Decision / Review / Handoff）—
  [中文](rfcs/0003-collaboration-objects.md) / [EN](../en/rfcs/0003-collaboration-objects.md)
- [x] RFC：人机对称 API —
  [中文](rfcs/0004-human-agent-api.md) / [EN](../en/rfcs/0004-human-agent-api.md)
- [x] RFC：上下文存储与生命周期（Event / Blob / Digest / GC）—
  [中文](rfcs/0005-context-storage-lifecycle.md) / [EN](../en/rfcs/0005-context-storage-lifecycle.md)
- [x] RFC：ACL 权限域与 Agent 身份 —
  [中文](rfcs/0006-acl-agent-identity.md) / [EN](../en/rfcs/0006-acl-agent-identity.md)
- [x] RFC：日蒸馏（含 D0 规则路径）—
  [中文](rfcs/0007-daily-distillation.md) / [EN](../en/rfcs/0007-daily-distillation.md)
- [x] 技术栈 — [TECH_STACK.md](TECH_STACK.md)
- [ ] 与 `regenic-ai/regenic-book/content/*/standards/` 公开 schema 对齐 —
  见 [book-schema-map.md](rfcs/book-schema-map.md)
- [ ] 经 Issues 评审将 RFC 从 Draft → Accepted（按下方收口顺序）
- [x] Spike：monorepo 脚手架（无业务语义；见仓库根目录）

**退出标准（HardGate）：** 七份 RFC 均已 Accepted，且 book schema 对齐完成。
本阶段不要求生产业务代码；允许无语义脚手架。

### 收口顺序

按 RFC 依赖分四波评审；Accept 时同步改中英文 RFC 头与 [rfcs/README.md](rfcs/README.md)。

| 波次 | RFC | 焦点 | 通过后解锁 |
| --- | --- | --- | --- |
| A | 0001、0002 | 标准模型；Claim/Snapshot | SoftGate；`packages/domain` 类型可固化 |
| B | 0003、0005 | 协作对象；Event/Blob/Digest | 协作与物理存储 schema |
| C | 0004、0006 | `/v1` API；ACL / Agent 身份 | OpenAPI 与鉴权可固化 |
| D | 0007 | 日蒸馏 D0→accept | Worker 蒸馏任务可开写 |

**SoftGate（可开写 Phase 1 业务代码）：** RFC **0001 Accepted** + book schema 对齐完成。
不要求七份全部 Accepted。

**Spike（可与评审并行）：** `apps/api`、`apps/worker`、`packages/domain`、
`packages/config` + Docker Compose；仅 health / 连通性，禁止 standards CRUD、
蒸馏、ACL 等业务实现。

索引：[rfcs/README.md](rfcs/README.md) · [TECH_STACK.md](TECH_STACK.md)。

## Phase 1 — 统一判断标准

编码书中的**标准机器**（standards machine）：

- [ ] 标准定义格式（机读 + 人读）
- [ ] 版本与修订历史
- [ ] 应用钩子 — Agent 与人如何引用 / 应用标准
- [ ] 校验 — 检测「声称的标准」与「观察到的行为」漂移
- [ ] 渐进生命周期 — draft → trial → active，含五闸门
      （RFC 0001）

**退出标准：** 一个团队能发布、应用并修订一条组织级标准，而不必为每个团队另开聊天线程。

## Phase 2 — 统一上下文

编码书中的**共识机器**（consensus machine）：

- [ ] 组织级上下文层（非按应用割裂的孤岛）
- [ ] 出处 — 每条上下文 claim 从何而来
- [ ] 访问边界 — 谁与哪些 Agent 能看见什么（RFC 0006）
- [ ] 物理接入路径 — Event / Blob + 热窗索引（RFC 0005）
- [ ] D0 日蒸馏 → 人审 accept → Proposal/Standard 进料（RFC 0007）
- [ ] Snapshot / Bundle — 同一决策 → 同一事实集（RFC 0002）
- [ ] 与标准同步 — 实质上下文变更触发标准复审
- [ ] 协作闭环 — 在共享 Snapshot 上的 Proposal → Decision → Review
      （RFC 0003）

**退出标准：** 两个团队与一个 Agent 能为同一决策共享同一上下文 Snapshot，而无需从 Slack 复制粘贴；日 Digest 遵守 ACL 并引用证据 Event。

## Phase 3 — 组织管理产品

AI 原生组织的默认管理界面：

- [ ] 建立在标准 + 上下文上的运营工作流（非表单优先的 ERP）
- [ ] 与人机 UI 并列的 Agent 原生界面（同一 API，RFC 0004）
- [ ] 集成适配器（身份、通知、既有工具）— 靠后，不靠前

**退出标准：** bioby.ai 在 Regenic 上跑通一条真实端到端工作流。

---

## 当前非目标

- 重建通用 ERP 模块（人事、财务、库存）
- 以「替换各团队聊天」为**主**产品叙事（先接入 + 蒸馏；可选的 Regenic 原生沟通壳后置）
- 引入 `regenic-internal` 私有材料
- 无标准 / 上下文绑定的无界 Agent 编排

## 跟踪

里程碑与议题：[github.com/regenic-ai/regenic/issues](https://github.com/regenic-ai/regenic/issues)
