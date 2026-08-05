# RFC 0006 — ACL 权限域与 Agent 身份

- **状态：** Draft
- **English:** [../../en/rfcs/0006-acl-agent-identity.md](../../en/rfcs/0006-acl-agent-identity.md)
- **依赖：** RFC 0002（`AccessPolicy`）、RFC 0004（API 主体）、RFC 0005（Event/Digest 挂载点）
- **相关：** RFC 0007（蒸馏不得升权）
- **方法论：** 《重写基因》第 9 章 — 统一上下文 ≠ 透明一切

## 1. 问题

RFC 0002 在 claim 上定义了 `AccessPolicy`。运营接入（频道、工单、Agent）
需要具体的 **membership** 模型、Agent 绑定规则，以及列表/搜索/向量/prompt
组装共用的单一 `visible()`。

没有这些，蒸馏与「共享上下文」会静默变成权限放大。

## 2. 目标

1. 人与 Agent 都是 `Principal`；Agent 永远不得获得影子全组织视图。
2. 授权挂在 **AclScope** 上，而非复制数据。
3. 蒸馏不能扩大可见性（严格 Digest 规则）。
4. 一切读路径共用一个 `visible(principal, resource)`。
5. 授权、破窗与 Agent 绑定可审计。

## 3. 非目标

- 完整 IdP 产品（OIDC/SAML 适配器后置）。
- 逐条消息分享 UX（v1 使用 scope + 显式分享）。
- 替换 RFC 0002 `AccessPolicy` — 本 RFC 为存储对象**实现**它，并映射到 claim 策略。

## 4. 身份

### 4.1 `Principal`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | |
| `org_id` | string | |
| `kind` | enum | `human` \| `agent` \| `service` |
| `display_name` | string | |
| `status` | enum | `active` \| `disabled` |
| `external_refs` | object | 飞书/企微/Slack ids |

映射到 RFC 0004 `ActorRef`：相同的 `kind` + `id`。

### 4.2 `AgentBinding`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `agent_id` | string | Principal kind=agent |
| `mode` | enum | `as_user` \| `as_service` \| `dual` |
| `bound_human_id` | string \| null | `as_user` 时必填 |
| `service_scope_ids` | string[] | `as_service` 时必填 |
| `can_write_event` | bool | |
| `can_propose_digest` | bool | |
| `can_propose_standard` | bool | 默认 false |
| `max_evidence_class` | string \| null | 可选上限 |

| Mode | 有效 ACL |
| --- | --- |
| `as_user` | 与绑定人求交；审计 `on_behalf_of` |
| `as_service` | 仅 `service_scope_ids` — **无**隐式 org-admin |
| `dual` | 会话令牌与 job 令牌分离 |

**禁止：** 用于蒸馏的长生 org-admin agent 令牌。

## 5. AclScope

### 5.1 类型

| kind | 用途 |
| --- | --- |
| `org` | 组织内公开（仍非无限制机密） |
| `unit` | 部门 / BU |
| `project` | 作战单元 |
| `channel` | IM / 工单房间（对齐 `Event.channel_id`） |
| `standard_ring` | 受限标准圈 |
| `ad_hoc` | 并购、人事案 |

### 5.2 表

**AclScope：** `id`, `org_id`, `kind`, `name`, `parent_id?`, `sensitivity`
（`public_in_org` \| `internal` \| `confidential` \| `restricted`）, `attrs`。

**AclMembership：** `scope_id`, `principal_id`, `role`
（`reader` \| `writer` \| `acl_admin` \| `content_reader`）,
`granted_by`, `granted_at`, `expires_at?`,
`source`（`manual` \| `hr_sync` \| `channel_mirror` \| `project_sync`）。

拆分 `acl_admin` 与 `content_reader`，使 HRBP 式管理员不必读取正文。

### 5.3 继承（保守）

部门树**不**自动授予祖先对后代频道内容的读取权。
CEO/高管访问靠**显式 membership** 或破窗 — 不靠树魔法。

## 6. 资源挂载

| 资源 | 字段 | 说明 |
| --- | --- | --- |
| Event | `acl_scope_id` | 通常为 channel scope |
| Digest | `acl_scope_id` + `required_scope_ids` | 见 §8 |
| Standard | `acl_scope_id` | 读；激活另议 |
| Blob | 无 | 仅经 `via_event_id` / `via_digest_id` 访问 |
| Claim（0002） | `AccessPolicy` | 铸造 claim 时从 scope 映射 |

## 7. `visible()`（规范性）

```
visible(P, R) =
  active(P)
  ∧ ¬R.tombstone_hides_from(P)   -- tombstone 对 admin 仍可见元数据
  ∧ (
      has_role(P, R.acl_scope_id, reader+)
      ∨ explicit_share(R, P)
      ∨ valid_break_glass(P, R)
    )
```

对带 `required_scope_ids = S1..Sn` 的 Digest：

```
visible(P, Digest) ⇔ ∀ Si ∈ required_scope_ids: has_role(P, Si, reader+)
```

**搜索 / 向量 / preview / prompt 组装必须先 ACL 过滤再排序。**
返回「隐藏命中」元数据是缺陷。

Blob 下载：针对 **via** 资源鉴权，而非裸 hash。

## 8. 蒸馏与权限

1. Job 以带窄 `service_scope_ids` 的 `service` principal 运行。
2. `required_scope_ids` 由证据**派生**；写入方不可改宽。
3. 可选 Phase-2 **脱敏 Digest**：仅结论正文、更宽 scope、
   无 event id / 可逆摘句；创建可审计。
4. 权重（RFC 0007）仅在可见集合内生效 — **权重 ≠ ACL 绕过**。

## 9. 写操作

| 动作 | 需要 |
| --- | --- |
| 写 Event | scope `writer` +（若为 agent）`can_write_event` |
| 提 Digest | `can_propose_digest` + 证据可见 |
| Accept Digest | 人类方向 owner 或 scope admin |
| 激活 StandardVersion | 人类（绝非 agent 单独） |
| 变更 membership | `acl_admin` |

## 10. 外源镜像

- 飞书/企微/Slack/工单 membership → `channel` scope membership。
- 离开频道 ⇒ membership 过期。
- 源侧「工作区管理员可见全部」**不**映射为 Regenic org_admin，除非
  客户显式启用 mirror-admin 特权。
- 源侧撤回 ⇒ Event `tombstone`；ACL 不变；正文按 RFC 0005 GC。

## 11. 破窗（Break-glass）

短 TTL 升权，必填原因、审批人、强制安全通知。
任何破窗读取会延长所触证据的 GC 保活。

## 12. 映射到 RFC 0002 `AccessPolicy`

| AccessPolicy.visibility | 典型 scope 物化 |
| --- | --- |
| `org` | `kind=org` membership |
| `team` | `unit` / `project` scope |
| `decision_scoped` | Snapshot `built_for_principals` + claim 策略 |
| `restricted` | `ad_hoc` / `standard_ring` + deny_exfiltrate |

从 Event 铸造 Claim 时，有效敏感级应上收复制（绝不下放）。

## 13. 验收标准

1. Agent `as_user` 不能读取绑定人不能读取的频道。
2. 含受限证据 Event 的日 Digest，对缺少该 scope 的 principal 不可见
   （除非存在脱敏兄弟版）。
3. 关闭 ACL filter 的向量搜索会使 CI 失败。

## 14. 待决问题

- 客服频道中的外部客户 principal（建议：是，仅 channel）。
- 多 Agent 线程：优先每 Agent `as_user`，而非共享 service scope。
- 脱敏 Digest 是否默认可进入组织级日包（默认：否）。
