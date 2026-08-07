# 个人库 → 组织 Canonical

- **English:** [../../en/rfcs/personal-to-org.md](../../en/rfcs/personal-to-org.md)
- **状态：** 产品架构草稿（非编号 RFC）
- **依赖：** RFC 0005（Event/Blob）、0002（图谱）、0006（ACL）、0007（蒸馏）
- **产品：** [PRODUCT.md](../PRODUCT.md)

## 1. 问题

个人版 Regenic 为单一 principal 跑通完整加工闭环。组织版要把多条个人流合并，且不能：

- 把每人的副本都当成不同事实（UNION 爆炸），或  
- 把个人 AI 标签提升为组织真理，或  
- 借蒸馏任务升权。

## 2. 模型

```text
渠道消息（push 或 pull）
  → 个人 Event（+ 个人加工标签）
  → [显式同意 / work-scope 策略]
  → 组织 Canonical Event（一条物理事实）
       + Projection（按接入人 / 视角）
  → 组织 Digest / Claim / Snapshot（org job + visible()）
```

| 概念 | 角色 |
| --- | --- |
| 个人 Event | 投影 + 主观标签（优先级、「该知道」、未回复） |
| Canonical Event | 客观事实：谁 / 何时 / 什么 / 线程 / tombstone |
| Projection | 谁接入的、其可见范围、个人标签 |
| 组织 Digest | 仅由组织管道产出（RFC 0007）；禁止盲拷个人标签 |

## 3. 身份与去重

1. 跨人联结优先 `(org_id, source, external_id)`。  
2. 否则 `(org_id, content_hash, ts_bucket, actor_canonical)`。  
3. Blob 仍 `content_hash` 内容寻址；组织层只存/引用一次。  
4. Actor 经 IdentityProvider 映射；失败 → `unresolved`，禁止强行合并。

## 4. 客观 vs 主观

| 类别 | 权威 | 例子 |
| --- | --- | --- |
| 客观 | Canonical Event | 正文 hash、源时间、thread id、tombstone |
| 主观 | 个人投影 | 分级、该知道、未回复排序、个人摘要 |

组织蒸馏可以**参考**主观标签作提示；必须在 `visible(job)` 下重算组织输出，
并写入带组织出处的 Digest / Claim。

## 5. 同意与范围

- 默认仅汇聚 work 绑定的连接器 / 频道。  
- 个人私聊默认不进，除非显式 opt-in。  
- 按连接器或 scope 授权汇聚。  
- 组织热库优先薄 Event + hash；正文按需拉取并审计。

## 6. 冲突

- 同 hash → 一条 canonical，多条 projection。  
- 编辑 / 撤回 → 版本或 `superseded` 链；禁止覆盖。  
- 未回复状态保持「每人一份」，除非源系统自有共享状态（如工单状态）。

## 7. 开源 vs 闭源

| 表面 | 意图 |
| --- | --- |
| 个人运行时、本地库、导出、连接器（参考实现） | 开源（本仓） |
| 多人汇聚、企业 IdP、合规 hold | 闭源 / 商业 |

## 8. 验收（组织叠加层）

1. 两人接入同一条飞书消息 → 一条 canonical Event，两条 projection。  
2. 个人「该知道」标签不会在没有 org job 的情况下变成组织 Claim。  
3. 关闭个人云历史，不影响仍同意汇聚的同伴侧 canonical 认同。
