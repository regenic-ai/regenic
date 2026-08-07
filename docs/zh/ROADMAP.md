# 路线图

[English](../en/ROADMAP.md)

Regenic 分层交付。每一层须可独立使用后再开下一层——与《重写基因》中的渐进式迭代闸门一致。

**产品命题：** Regenic 是**信息加工层**（接入 → 过滤 → 分层 → 提炼事实 → 迭代标准）。
它不生产渠道一手内容。交付顺序为**个人（开源、本地优先）→ 组织（汇聚）**。
见 [PRODUCT.md](PRODUCT.md)。

## Phase 0 — 架构（HardGate 已满足）

- [x] RFC：标准数据模型（定义、范围、版本、生命周期）—
  [中文](rfcs/0001-standards-data-model.md) / [EN](../en/rfcs/0001-standards-data-model.md) — **Accepted**
- [x] RFC：上下文图谱（实体、关系、出处、访问）—
  [中文](rfcs/0002-context-graph.md) / [EN](../en/rfcs/0002-context-graph.md) — **Accepted**
- [x] RFC：协作对象（Proposal / Decision / Review / Handoff）—
  [中文](rfcs/0003-collaboration-objects.md) / [EN](../en/rfcs/0003-collaboration-objects.md) — **Accepted**
- [x] RFC：人机对称 API —
  [中文](rfcs/0004-human-agent-api.md) / [EN](../en/rfcs/0004-human-agent-api.md) — **Accepted**
- [x] RFC：上下文存储与生命周期（Event / Blob / Digest / GC）—
  [中文](rfcs/0005-context-storage-lifecycle.md) / [EN](../en/rfcs/0005-context-storage-lifecycle.md) — **Accepted**
- [x] RFC：ACL 权限域与 Agent 身份 —
  [中文](rfcs/0006-acl-agent-identity.md) / [EN](../en/rfcs/0006-acl-agent-identity.md) — **Accepted**
- [x] RFC：日蒸馏（含 D0 规则路径）—
  [中文](rfcs/0007-daily-distillation.md) / [EN](../en/rfcs/0007-daily-distillation.md) — **Accepted**
- [x] 技术栈 — [TECH_STACK.md](TECH_STACK.md)
- [x] 与 `regenic-ai/regenic-book/content/*/standards/` 公开 schema 对齐 —
  见 [book-schema-map.md](rfcs/book-schema-map.md)（#8）
- [x] 经 Issues 评审将 RFC 从 Draft → Accepted — **0001–0007 均已 Accepted**
- [x] Spike：monorepo 脚手架（无业务语义；见仓库根目录）

**退出标准（HardGate）：** 已满足 — 七份 RFC 均 Accepted，且 book schema 对齐完成。

索引：[rfcs/README.md](rfcs/README.md) · [TECH_STACK.md](TECH_STACK.md) ·
[PRODUCT.md](PRODUCT.md) · [个人 → 组织](rfcs/personal-to-org.md)。

## Phase 1 — 个人信息加工（当前）

交付开源、**本地优先**、面向单一 principal 的加工闭环。Push 与 pull 接入同等；
产品加工信息 — 不生产渠道内容。

- [ ] 本地权威库（SQLite 或单机 Postgres）+ 本地 Blob
- [ ] ChannelConnector 接入（push 和/或 pull）≥1 个真实渠道
- [ ] 过滤 + 分层落入 Event / Blob（RFC 0005 形状，个人 scope）
- [ ] 管道上的加工表面：优先级 /「该知道」/ 跟进（如未回复）—
      作为加工的**输出**，而非产品定义
- [ ] 开放导出（Markdown / JSONL）
- [ ] 可选云历史（默认关；用户可控；非组织库）
- [ ] 个人规则 / 轻量标准钩子（通向 RFC 0001）

**退出标准：** 一个人能在本地接入真实渠道流量，完成 过滤→分层→蒸馏→行动，
且无需厂商云；并能导出其库。

**Phase 1 非目标：** 第二大脑 / Outliner、Notion 克隆、组织 canonical 汇聚、多租户 ACL。

## Phase 2 — 加深个人加工 + 标准路径

- [ ] 更强蒸馏（个人 Digest；适用处用 D0 风格规则）
- [ ] 个人标准 / 规则迭代（RFC 0001 生命周期子集）
- [ ] 声称规则与实际跟进之间的漂移信号
- [ ] 更多连接器；可插拔 ModelProvider（仅 propose）

**退出标准：** 个人闭环含有证据支撑的蒸馏，以及至少一条修订过的个人规则/标准，
且不以聊天为系统真相源。

## Phase 3 — 组织叠加层（汇聚）

闭源/商业路径：将获同意的个人流拼成组织真相。

- [ ] Canonical Event + Projection 模型（[个人 → 组织](rfcs/personal-to-org.md)）
- [ ] 身份映射；work-scope 同意；不升权（RFC 0006）
- [ ] 组织 Digest / Claim / Snapshot（RFC 0002、0007）— org job 重算，
      不盲拷个人标签
- [ ] 共享 Snapshot 上的协作闭环（RFC 0003）
- [ ] 组织级完整标准机器（RFC 0001）

**退出标准：** 两人接入同一源消息 → 一条 canonical Event + 两条 projection；
组织 Digest 引用证据且不升权。

## Phase 4 — 组织管理产品

- [ ] 建立在标准 + 上下文上的运营工作流（非表单优先的 ERP）
- [ ] 与人机 UI 并列的 Agent 原生界面（同一 API，RFC 0004）
- [ ] 企业适配器（IdP、通知、合规）— 靠后，不靠前

**退出标准：** bioby.ai 在 Regenic 上跑通一条真实组织端到端工作流。

---

## 当前非目标

- 重建通用 ERP 模块（人事、财务、库存）
- 以「替换各团队聊天 / 做第二大脑」为**主**产品叙事
- 引入 `regenic-internal` 私有材料
- 无标准 / 上下文绑定的无界 Agent 编排
- 把个人 AI 标签未经组织蒸馏直接当作组织真理

## 跟踪

里程碑与议题：[github.com/regenic-ai/regenic/issues](https://github.com/regenic-ai/regenic/issues)
