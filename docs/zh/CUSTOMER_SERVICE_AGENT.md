# 客服 Agent 配置与使用

Regenic 现在可以把一条已授权的客户消息建立为持久客服任务。Agent 可在任务范围内检索和续读对话证据、提交带引用的问题解释、查询受控只读业务服务并生成客户可见草稿。草稿必须先在桌面端由人工批准，Regenic 才允许发送。

## 1. 配置业务查询服务

在 Regenic API/内核进程中设置：

```powershell
$env:REGENIC_CUSTOMER_BUSINESS_URL = "https://business-tools.example.com/v1/customer-status/query"
$env:REGENIC_CUSTOMER_BUSINESS_TOKEN = "<secret>"
$env:REGENIC_CUSTOMER_BUSINESS_TIMEOUT_MS = "10000" # 可选，100-60000
```

URL 必须使用 HTTPS；本地开发允许回环 HTTP。配置 URL 不允许包含账号密码、query 或 fragment。

Regenic 发送：

```json
{
  "schema_version": "1.0",
  "customer_id": "customer-a",
  "project_id": "project-a",
  "batch_id": "batch-2026-10",
  "members": [
    { "member_key": "creator-a", "business_id": "crm-123" }
  ],
  "fields": ["invitation_response"],
  "query_at": "2026-10-22T04:00:00.000Z"
}
```

业务服务必须自行强制执行 tenant/customer/project 授权、字段白名单、行数上限和只读约束。响应只能包含请求的对象和字段：

```json
{
  "schema_version": "1.0",
  "queried_at": "2026-10-22T04:01:00.000Z",
  "complete": true,
  "results": [
    {
      "member_key": "creator-a",
      "business_id": "crm-123",
      "status": "found",
      "record_id": "status-123",
      "record_version": "7",
      "fields": [
        {
          "field": "invitation_response",
          "value": "declined",
          "visibility": "customer",
          "authority": "crm-invitation-status",
          "updated_at": "2026-10-22T03:55:00.000Z"
        }
      ]
    }
  ]
}
```

结果状态只能是 `found`、`not_found`、`ambiguous`、`permission_denied` 或 `unavailable`。`not_found` 绝不等于“尚未回复”。还有分页时返回 `complete: false` 和 `next_page`。客户回复只能引用 `visibility: customer` 的字段。

## 2. 构建本地 Agent 工具服务

```powershell
pnpm --filter @regenic/local-cli... build
```

在目标 Cursor 中增加以下 stdio MCP 配置，并把路径替换为当前代码仓库的绝对路径：

```json
{
  "mcpServers": {
    "regenic-customer-service": {
      "command": "node",
      "args": [
        "C:\\path\\to\\regenic\\packages\\local-cli\\dist\\main.js",
        "customer-service-mcp",
        "--base-url",
        "http://127.0.0.1:4370"
      ],
      "env": {
        "REGENIC_PERSONAL_API_KEY": "<personal API key>"
      }
    }
  }
}
```

只有不要求 personal key 的回环内核才能省略该 key。MCP 进程只接受 HTTPS 或回环 HTTP API 地址，并暴露：

- `create_customer_task`
- `search_context`
- `read_context`
- `update_customer_brief`
- `query_customer_business`
- `create_customer_reply_draft`
- `get_customer_task`

它有意**不暴露**审核和发送工具。对话证据不能授予权限、执行 SQL、批准草稿或直接向客户发消息。

## 3. Agent 工作流

1. 使用当前来源 Event ID 和 content hash 创建任务。
2. 调用 `search_context`；有 continuation 时按需调用 `read_context`。
3. 客户、项目、批次、问题含义和成员未被引用支持前，保持 unresolved/candidate/conflicting。
4. 提交 brief。每个 verified 范围值都必须引用当前任务证据，每个 verified 成员必须同时提供 `evidence` 和 `identity_evidence`。只有范围 ID、闭合成员集合、稳定业务 ID、待查字段和剩余缺口均有效，服务端才进入 `ready_for_query`。
5. 查询业务数据；分页未完成时不得形成完整集合结论。
6. 草稿必须逐条绑定 BusinessEvidence，并声明成员覆盖。
7. 人工在桌面端左侧 **客服任务** 中审核。
8. 发送前 Regenic 会重新查询业务源；事实变化会令批准失效，必须重新生成和审核。已有回复幂等机制避免重复发送。

只有客户和项目范围已核验后，`include_related: true` 才允许搜索其他已授权会话。跨会话命中仍只是证据候选，不能自行改变权限。

## 4. 通过 HTTP 获取 Agent 可直接使用的对话上下文

外部应用不应把搜索摘要当作对话历史，而应调用聚合检索接口：

```http
POST /v1/me/context/search/expand
Content-Type: application/json
X-Regenic-Personal-Key: <personal API key>
```

```json
{
  "query": "上次选中的 2 位都还没回复吗？",
  "limit": 10,
  "context": {
    "before": 4,
    "after": 4,
    "reply_depth": 8,
    "max_messages": 40
  }
}
```

每个返回会话包含：

- 标识对话的 `thread_id`；
- 标识检索命中的 `anchor_event_ids`；
- 每条消息的 `event_id`、来源原生 `external_id`、`content_hash`、时间、发送者和正文；
- 存在回复关系时的 `parent_external_id` 和已解析的 `reply_to_event_id`；
- `selection_reason`：`hit`、`reply_target` 或 `neighbor`；
- 有历史被省略时的 `continuation.before`、`continuation.after` 和 `continuation.gaps` 边界；
- 返回消息并非连续完整本地会话时的 `truncated: true`。

服务端会在扩展前重新核验每个命中是否仍是当前生命周期 head，正文哈希是否仍一致。收到 `409 context_changed` 时，应用必须重新搜索。`limit` 上限为 20，扩展消息上限为 100，并且 `limit` 不能超过 `context.max_messages`。

这里的“完整”仍然是有界完整：选中的每条消息要么返回完整正文，要么请求显式失败；接口不声称连接器已经同步完全部来源历史。对话证据可以帮助识别业务对象和问题含义，但实时业务状态仍必须从受控业务查询服务获取。

## 5. 运行边界

- 现有 `/v1/me/context/search`、`/search/source` 和 `/ask` 行为不变；`/search/expand` 是面向 Agent 的聚合接口。
- 客服任务、brief 版本、业务证据、草稿、审核和发送状态都持久化在 Authority store。
- 清理 Regenic 运行数据时会同时清理客服任务。
- 本地 Embedding 不代表远端 Cursor 或业务服务也在本地，仍须遵守部署的数据出站策略。
- 首版对业务系统只读，对客发送始终需要人工批准。

设计依据、完整性语义和验收指标见[客服 Agent 问题补全与业务查询改造方案](AGENT_CONTEXT_RETRIEVAL_PROPOSAL.md)。
修改检索或工作流安全行为前后，应运行[客服场景评测门禁](CUSTOMER_SERVICE_EVALUATION.md)。
