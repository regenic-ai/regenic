# RFC 0004 — 人机对称 API

- **状态：** Accepted
- **English:** [../../en/rfcs/0004-human-agent-api.md](../../en/rfcs/0004-human-agent-api.md)
- **依赖：** RFC 0001、RFC 0002、RFC 0003
- **方法论：** 双能力模型 — 人拥有共识与下一条标准；Agent 执行标准已覆盖的部分

## 1. 问题

若人用一套 UI schema、Agent 用另一套临时 prompt 对着不同数据，上下文会再次碎片化。
Regenic 需要**一个对象模型、两种呈现**（人机 UI 与 Agent API），并在每次执行上
硬绑定 `standard_version` + `context_snapshot`。

## 2. 目标

1. 暴露标准、上下文、协作与 run 的**对称资源 API**。
2. 在 agent 执行与人类「应用标准」动作上强制**钉死**标准 + 上下文。
3. 返回**可观察**结果（绑定、例外、handoff 原因）。
4. v1 保持传输无关（HTTP/JSON 为参考绑定）。

## 3. 非目标

- 选定具体 LLM 供应商或 agent 框架。
- Slack/邮件适配器（Phase 3）。
- 流式 token 协议（可后加；资源协议保持）。

## 4. 认证 / 鉴权

| 概念 | 规则 |
| --- | --- |
| Principal | 每个请求认证为 `ActorRef`（`human` \| `agent` \| `system`） |
| Org | 所有路径按 org 作用域：`/v1/orgs/{org_id}/...` |
| Access | Claim 可见性遵循 RFC 0002 `AccessPolicy`；agent 永不收到被拒绝的 claim 正文 |
| Audit | 每次变更调用写审计事件：actor、resource、前后 hash |

Agent 是带作用域令牌的一等 principal；它们不静默假扮人类。代表人类行动需要
显式 `on_behalf_of` 字段且策略允许。

## 5. 资源图

对称资源（人机 UI 与 Agent 客户端调用同一路由）：

| 资源 | 路径前缀 | RFC |
| --- | --- | --- |
| Standards | `/standards` | 0001 |
| Standard versions | `/standards/{id}/versions` | 0001 |
| Standard gaps | `/standard-gaps` | 0001 |
| Entities / claims / edges | `/context/...` | 0002 |
| Snapshots / bundles | `/context/snapshots`, `/context/bundles` | 0002 |
| Proposals | `/proposals` | 0003 |
| Decisions | `/decisions` | 0003 |
| Reviews | `/reviews` | 0003 |
| Handoffs | `/handoffs` | 0003 |
| Agent runs | `/runs` | 本 RFC |

### 5.1 通用约定

- JSON 请求/响应；与 RFC 类型匹配的 `snake_case` 字段。
- 幂等：变更 POST 接受 `Idempotency-Key`。
- 错误：`{ "error": { "code", "message", "details?" } }`
- 列表端点支持游标分页。

**错误码（节选）：**

| 码 | 何时 |
| --- | --- |
| `standard_binding_required` | 执行/决策未钉版本 |
| `snapshot_required` | 缺少 `context_snapshot_id` |
| `gate_incomplete` | 无 UpgradeEvidence 却晋升 |
| `evidence_required` | 提交 Proposal 无证据 |
| `access_denied` | 策略拦截 |
| `single_uncertainty_required` | 标准提案缺少闸门 1 |
| `handoff_required` | Agent 撞边界；必须创建 Handoff |

## 6. Standards API（草图）

```http
POST   /v1/orgs/{org_id}/standards
GET    /v1/orgs/{org_id}/standards/{standard_id}
POST   /v1/orgs/{org_id}/standards/{standard_id}/versions
POST   /v1/orgs/{org_id}/standards/versions/{version_id}:publish_trial
POST   /v1/orgs/{org_id}/standards/versions/{version_id}:promote
POST   /v1/orgs/{org_id}/standards/versions/{version_id}:deprecate
GET    /v1/orgs/{org_id}/standards/versions/{version_id}
```

晋升校验 RFC 0001 `UpgradeEvidence`。失败 → `gate_incomplete`。

## 7. Context API（草图）

```http
POST   /v1/orgs/{org_id}/context/entities
POST   /v1/orgs/{org_id}/context/claims
POST   /v1/orgs/{org_id}/context/edges
POST   /v1/orgs/{org_id}/context/snapshots
GET    /v1/orgs/{org_id}/context/snapshots/{snapshot_id}
POST   /v1/orgs/{org_id}/context/bundles:resolve
```

`bundles:resolve` 请求体：

```json
{
  "snapshot_id": "...",
  "principal": { "actor_type": "agent", "actor_id": "..." }
}
```

响应为 `ContextBundle`（RFC 0002）。两位策略等价的 principal
**必须**看到相等的可见 `content_hash`。

## 8. Collaboration API（草图）

```http
POST   /v1/orgs/{org_id}/proposals
POST   /v1/orgs/{org_id}/proposals/{id}:submit
POST   /v1/orgs/{org_id}/proposals/{id}:accept
POST   /v1/orgs/{org_id}/proposals/{id}:reject
POST   /v1/orgs/{org_id}/decisions
POST   /v1/orgs/{org_id}/reviews
POST   /v1/orgs/{org_id}/handoffs
POST   /v1/orgs/{org_id}/handoffs/{id}:ack
POST   /v1/orgs/{org_id}/handoffs/{id}:resolve
```

`proposals:submit` 强制执行 RFC 0003 的证据 + snapshot 规则。

## 9. Agent runs（执行面）

### 9.1 `AgentRun`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | |
| `agent` | `ActorRef` | `actor_type = agent` |
| `on_behalf_of` | `ActorRef` \| null | |
| `intent` | string | 要做什么 |
| `status` | enum | `queued` \| `running` \| `succeeded` \| `failed` \| `handed_off` \| `cancelled` |
| `context_snapshot_id` | string | 必需 |
| `standard_bindings` | `StandardBinding[]` | 必需且非空 |
| `input` | object | 任务特有 |
| `output` | `RunOutput` \| null | |
| `handoff_id` | string \| null | `handed_off` 时设置 |
| `started_at` | datetime \| null | |
| `finished_at` | datetime \| null | |

### 9.2 `RunOutput`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `summary` | string | |
| `artifacts` | object[] | |
| `applied_standard_version_ids` | string[] | 实际使用的绑定回声 |
| `context_snapshot_id` | string | 回声 |
| `acceptance_check` | enum | `pass` \| `fail` \| `not_applicable` |
| `exceptions` | string[] | 边界 / 未覆盖情形 |
| `confidence` | number \| null | |

### 9.3 端点

```http
POST   /v1/orgs/{org_id}/runs
GET    /v1/orgs/{org_id}/runs/{run_id}
POST   /v1/orgs/{org_id}/runs/{run_id}:cancel
```

创建体**必须**包含 `context_snapshot_id` 与 `standard_bindings`。
缺任一 → 硬错误（无隐式「用最新组织大脑」）。

当 agent 撞到边界时，run 转为 `handed_off` 并创建带 Agent→Human reason 的
`Handoff`。继续需要 Human→Agent handoff resolve（或带更新绑定/snapshot 的新 run）。

### 9.4 人类「应用标准」对等

```http
POST   /v1/orgs/{org_id}/decisions
```

人机 UI「在此标准下决策」与上述资源创建相同：钉死的 snapshot + bindings。
没有并行的未文档化路径。

## 10. 闭环（规范性顺序）

```text
StandardGap or human intent
  → Proposal (+ evidence, snapshot, single_uncertainty)
  → accept → StandardVersion trial/active and/or Decision
  → Run (agent) or human execution under bindings
  → Review (validate | falsify)
  → revise standard / open gap / solidify
```

从聊天复制粘贴不是 API 步骤，且**不得**作为完成闭环的必需条件。

## 11. 漂移检测钩子

实现**应当**周期性比较：

- 所引用 `StandardVersion` 的 acceptance 标准
- 近期 `AgentRun.output.acceptance_check` 与人类 `Decision` 结果

反复 `fail` 打开 `Review`（RFC 0003 §7）。确切调度由实现定义。

## 12. 版本

- API 版本前缀 `/v1`。
- 优先加法变更；破坏性变更升 major。
- Draft 状态下 RFC 对象字段可演进而不升 `/v1`，直至首次生产发布冻结协议。

## 13. 验收标准

一个人与一个 agent 仅使用本 API（人机 UI 作为同一 API 的客户端）完成
Proposal → 引用标准 → Run → Review → 修订，而无需把私聊记录当作系统真相源。

## 14. 已裁定（#5 — 已批准）

- [x] **v1 handoff 通知用轮询。** 可选 webhook 放到 Phase 3。
- [x] **runs 始终异步。** 创建立即返回 `202` + `run_id`。
