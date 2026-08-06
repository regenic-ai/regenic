# RFC Accept 清单（Phase 0）

- **English:** [../../en/rfcs/accept-checklists.md](../../en/rfcs/accept-checklists.md)
- **跟踪：** [Milestone — Phase 0 — RFC acceptance](https://github.com/regenic-ai/regenic/milestone/1)

仅当清单全绿且中英文 RFC 头均为 `Accepted` 时关闭对应 GitHub Issue。

## Wave A

### RFC 0001 — 标准数据模型

Issue: [#1](https://github.com/regenic-ai/regenic/issues/1)

- [x] 中英字段名、枚举与生命周期图一致
- [x] `Standard` / `StandardVersion` / `Scope` / `IterationGate` / `UpgradeEvidence` /
      `TrialConfig` / `ActorRef` / `StandardGap` 对 Phase 1 完整
- [x] 五闸门可机检（非仅散文）
- [x] [book-schema-map.md](book-schema-map.md) SoftGate 项已裁定或在 §9 推迟
- [x] 与 0002（standard 实体 id）、0003（缺口→提案）、0004（引用钉死）无冲突
- [x] §9 待决问题已关闭或显式推迟并指定负责人

**强制核对契约点：**

1. Book 五段正文 ↔ `condition` / `action` / `acceptance` / `boundary` /
   `revision_trigger`
2. trial→active 需要 `UpgradeEvidence`（或已审计豁免）
3. 应用/run 绑定钉死 `standard_version_id`（存储侧禁止浮动 latest）

### RFC 0002 — 上下文图谱

Issue: [#2](https://github.com/regenic-ai/regenic/issues/2)

- [x] 中英字段名与枚举一致
- [x] `Entity.kind=standard` 引用 RFC 0001 `standard_id`，不复制正文
- [x] Claim `fact` / `hypothesis` / `opinion` 规则清晰；hypothesis 需验证窗
- [x] Claim/Edge 上具备 `Provenance` + `AccessPolicy`
- [x] Snapshot / ContextBundle 不可变与重放规则清晰
- [x] 与 0001 / 0003 / 0004 无冲突；方向兼容 0005/0006

**强制核对契约点：**

1. 同一决策 → 经 Snapshot 同一事实集
2. opinion 未转换前不得作 trial→active 证据
3. 撤回不改写历史；snapshot 保留旧 claim id

## Wave B

### RFC 0003 — 协作对象

Issue: [#3](https://github.com/regenic-ai/regenic/issues/3)

- [x] 中英一致
- [x] Proposal / Decision / Review / Handoff 的证据与 snapshot 规则清晰
- [x] Agent 不能独自激活标准（保留人类 accept 路径）
- [x] 与 0001/0002/0004 无冲突

### RFC 0005 — 上下文存储与生命周期

Issue: [#4](https://github.com/regenic-ai/regenic/issues/4)

- [x] 中英一致
- [x] Event / Blob / Digest / GC 耐久分层清晰
- [x] Event 喂给 Claim；不取代 0002 图谱语义
- [x] 与 0006/0007 无冲突

## Wave C

### RFC 0004 — 人机对称 API

Issue: [#5](https://github.com/regenic-ai/regenic/issues/5)

- [ ] 中英一致
- [ ] `/v1/orgs/{org_id}/...` 资源图覆盖标准、上下文、协作、runs
- [ ] ActorRef + `on_behalf_of` 规则清晰
- [ ] apply/run 钉死 standard + snapshot
- [ ] 与 0006 无冲突

### RFC 0006 — ACL 与 Agent 身份

Issue: [#6](https://github.com/regenic-ai/regenic/issues/6)

- [ ] 中英一致
- [ ] `visible()` 与蒸馏不升权清晰
- [ ] Principal ↔ ActorRef 映射清晰
- [ ] 权重 ≠ ACL 绕过（0007）

## Wave D

### RFC 0007 — 日蒸馏

Issue: [#7](https://github.com/regenic-ai/regenic/issues/7)

- [ ] 中英一致
- [ ] D0 规则路径与 D1 LLM 边界清晰
- [ ] 人审 accept → Proposal / Standard 进料清晰
- [ ] ACL 不升权得以保持

## 相关 Issues

| Issue | 标题 |
| --- | --- |
| [#8](https://github.com/regenic-ai/regenic/issues/8) | 与 regenic-book 公开 schema 对齐 |
| [#9](https://github.com/regenic-ai/regenic/issues/9) | Spike：monorepo 脚手架（无产品逻辑） |
