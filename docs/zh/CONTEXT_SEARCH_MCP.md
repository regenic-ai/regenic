# 对话上下文检索 MCP

Context Search MCP 让 Cursor 和其他 MCP 客户端直接从 Regenic 检索已授权的对话上下文。它返回有界对话窗口，而不是孤立的搜索摘要，并保留 Agent 引用证据和安全续读所需的定位信息。

## 构建与配置

构建本地 CLI：

```powershell
pnpm --filter @regenic/local-cli... build
```

在 MCP 客户端中加入以下 stdio server，并替换代码路径、API 地址和 key：

```json
{
  "mcpServers": {
    "regenic-context-search": {
      "command": "node",
      "args": [
        "C:\\path\\to\\regenic\\packages\\local-cli\\dist\\main.js",
        "context-search-mcp",
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

服务只接受 HTTPS 或回环 HTTP。只有本地 Personal API 未要求 key 时才能省略该环境变量。

## 工具

### `search_conversations`

搜索当前已授权文本，并把每个命中扩展为有界对话窗口。

```json
{
  "query": "上次选中的人都回复了吗？",
  "limit": 10,
  "filters": {
    "sources": ["slack"]
  },
  "context": {
    "before": 4,
    "after": 4,
    "reply_depth": 8,
    "max_messages": 40
  },
  "locale": "zh-CN"
}
```

结构化结果包含：

- 对话的 `thread_id`、`read_epoch`、标题和渠道名称；
- 被搜索命中的 `anchor_event_ids`；
- 每条消息的 `event_id`、来源原生 `external_id`、`content_hash`、发送者、时间和完整选中正文；
- `parent_external_id` 和已解析的 `reply_to_event_id`；
- `selection_reason`：`hit`、`neighbor` 或 `reply_target`；
- `truncated` 以及 `continuation.before`、`continuation.after` 和 `continuation.gaps`；
- 检索降级状态和有界完整性元数据。

### `read_conversation_window`

根据 `search_conversations` 返回的 continuation 读取被省略的上下文。`thread_id` 和 `read_epoch` 必须来自同一个会话结果。

读取 `before` 或 `after` 时传入对应边界和方向。读取内部 gap 时，从 `gap.after` 向后读取，并把 `gap.before` 作为 `until`：

```json
{
  "thread_id": "slack:C123",
  "read_epoch": "authorized:...",
  "direction": "after",
  "boundary": {
    "occurred_at": "2026-10-24T08:00:00.000Z",
    "event_id": "event-before-gap"
  },
  "until": {
    "occurred_at": "2026-10-24T09:00:00.000Z",
    "event_id": "event-after-gap"
  },
  "limit": 40,
  "locale": "zh-CN"
}
```

如果底层对话已经变化，Regenic 会拒绝过期的 `read_epoch`。此时应重新调用 `search_conversations`，不能把新旧证据混合使用。

## Agent 使用原则

1. 搜索命中只是上下文锚点，不是完整答案。
2. 每条事实引用都应保留 `event_id` 和 `content_hash`。
3. 当 `truncated=true` 且省略部分可能影响答案时，继续读取 continuation。
4. 不能把“对话中没有搜索到”解释成业务事实不存在。
5. 面向客户输出当前状态前，仍须查询已授权业务系统。

该 MCP 只提供只读上下文工具，不会授予新权限、执行业务查询、批准草稿或发送消息。
