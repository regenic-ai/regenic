# 路线图

[English](../en/ROADMAP.md)

Regenic 按层交付：一层能独立用起来，再开下一层——与《重写基因》里的渐进闸门一致。

**产品要点：** Regenic 是信息加工层（接入 → 过滤 → 分层 → 提炼事实 → 修订标准），
不生产渠道里的原始内容。交付顺序是**先个人（本地优先），后组织**。
详见 [产品定位](PRODUCT.md)。

## Phase 0 — 架构（已完成）

- [x] RFC：标准数据模型 —
  [中文](rfcs/0001-standards-data-model.md) / [EN](../en/rfcs/0001-standards-data-model.md) — **已接纳**
- [x] RFC：上下文图谱 —
  [中文](rfcs/0002-context-graph.md) / [EN](../en/rfcs/0002-context-graph.md) — **已接纳**
- [x] RFC：协作对象（Proposal / Decision / Review / Handoff）—
  [中文](rfcs/0003-collaboration-objects.md) / [EN](../en/rfcs/0003-collaboration-objects.md) — **已接纳**
- [x] RFC：人机对称 API —
  [中文](rfcs/0004-human-agent-api.md) / [EN](../en/rfcs/0004-human-agent-api.md) — **已接纳**
- [x] RFC：上下文存储与生命周期（Event / Blob / Digest / GC）—
  [中文](rfcs/0005-context-storage-lifecycle.md) / [EN](../en/rfcs/0005-context-storage-lifecycle.md) — **已接纳**
- [x] RFC：ACL 与 Agent 身份 —
  [中文](rfcs/0006-acl-agent-identity.md) / [EN](../en/rfcs/0006-acl-agent-identity.md) — **已接纳**
- [x] RFC：日蒸馏（含 D0 规则路径）—
  [中文](rfcs/0007-daily-distillation.md) / [EN](../en/rfcs/0007-daily-distillation.md) — **已接纳**
- [x] 技术栈 — [TECH_STACK.md](TECH_STACK.md)
- [x] 与 `regenic-book` 公开标准 schema 对齐 — [对照表](rfcs/book-schema-map.md)（#8）
- [x] 经 Issues 评审，RFC 全部从 Draft → Accepted（0001–0007）
- [x] 仓库脚手架（无业务语义；见仓库根目录）

**完成标准：** 七份 RFC 均已接纳，并与书稿公开 schema 对齐。

相关索引：[RFC](rfcs/README.md) · [技术栈](TECH_STACK.md) ·
[产品定位](PRODUCT.md) · [从个人到组织](rfcs/personal-to-org.md)。

## Phase 1 — 个人信息加工（当前）

先做出一个人能在本机跑通的加工闭环。拉取、推送都算正式接入；
Regenic 只加工信息，不生产渠道里的内容。

- [ ] 本机权威库（默认 SQLite）+ 本地 Blob 目录；任务用进程内队列
- [ ] 至少一个真实渠道的连接器（拉或推都行）
- [ ] 过滤、分层，写入 Event / Blob（形状跟 RFC 0005 对齐，范围限个人）
- [ ] 在管道上给出加工结果入口：优先级、「该知道」、跟进（如未回复）等——
      这些是输出，不是产品定义本身
- [ ] 开放导出（Markdown / JSONL）
- [ ] 可选远端历史（默认关；用户自己开；不是组织库）
- [ ] 个人规则 / 轻量标准钩子（为 RFC 0001 铺路）

**完成标准：** 一个人能在本地接上真实渠道，走完 过滤 → 分层 → 提炼 → 行动，
不依赖厂商云，并能导出自己的数据。

**本阶段不做：** 大纲笔记 / 通用笔记库、组织侧权威事件合并、多租户 ACL。

## Phase 2 — 加深个人加工，接上标准

- [ ] 更强的个人 Digest（合适处可用 D0 类规则）
- [ ] 个人规则/标准的修订（RFC 0001 生命周期的子集）
- [ ] 规则写了什么、实际跟进做得怎样——漂移提示
- [ ] 更多连接器；模型调用可插拔（只负责提出建议）

**完成标准：** 个人流程里已有带证据的提炼，并能修订至少一条个人规则/标准；
不以聊天记录当系统真相源。

## Phase 3 — 组织层

在当事人同意的前提下，把多条个人数据流合成为组织共享的事实。

- [ ] 权威 Event + 各人视角（[从个人到组织](rfcs/personal-to-org.md)）
- [ ] 身份映射、工作范围同意、蒸馏不抬权（RFC 0006）
- [ ] 组织 Digest / Claim / Snapshot（RFC 0002、0007）— 由组织任务重算，
      不照搬个人标签
- [ ] 共享 Snapshot 上的协作闭环（RFC 0003）
- [ ] 组织级完整标准机器（RFC 0001）

**完成标准：** 两人接入同一条源消息 → 一条权威 Event、两条视角；
组织 Digest 引用证据，且不扩大权限。

## Phase 4 — 组织管理界面

- [ ] 建在标准与上下文之上的运营流程（不是表单优先的 ERP）
- [ ] 人机界面与 Agent 共用同一套 API（RFC 0004）
- [ ] 企业侧适配（身份、通知、合规）放后面，不抢主线

**完成标准：** bioby.ai 在 Regenic 上跑通一条真实的组织端到端流程。

---

## 当前不做

- 通用 ERP 模块（人事、财务、库存）
- 以「替代团队聊天」或「第二大脑」当主叙事
- 引入 `regenic-internal` 私有材料
- 没有标准与上下文约束的无界 Agent 编排
- 个人 AI 标签不经组织加工就写成组织事实

## 跟踪

议题与里程碑：[github.com/regenic-ai/regenic/issues](https://github.com/regenic-ai/regenic/issues)
