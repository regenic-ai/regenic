# Context Search MCP

The Context Search MCP server lets Cursor and other MCP clients retrieve authorized conversation context directly from Regenic. It returns bounded conversation windows rather than isolated search snippets, including the identifiers an Agent needs to cite and continue the read safely.

## Build and configure

Build the local CLI:

```powershell
pnpm --filter @regenic/local-cli... build
```

Add this stdio server to the MCP client. Replace the checkout path, API URL, and key:

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

The server accepts HTTPS or loopback HTTP. The key may be omitted only when the loopback Personal API does not require one.

## Tools

### `search_conversations`

Searches current authorized text and expands each hit into a bounded conversation window.

```json
{
  "query": "Did all previously selected creators reply?",
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
  "locale": "en"
}
```

The structured result includes:

- conversation `thread_id`, `read_epoch`, title and channel label;
- `anchor_event_ids` selected by search;
- message `event_id`, source-native `external_id`, `content_hash`, actor, timestamp and full selected text;
- `parent_external_id` and resolved `reply_to_event_id`;
- `selection_reason`: `hit`, `neighbor`, or `reply_target`;
- `truncated` plus `continuation.before`, `continuation.after`, and `continuation.gaps`;
- retrieval degradation and bounded-completeness metadata.

### `read_conversation_window`

Reads omitted context from a continuation returned by `search_conversations`. Always copy `thread_id` and `read_epoch` from the same conversation result.

For a `before` or `after` continuation, pass that boundary and its direction. For a gap, read forward from `gap.after` and set `until` to `gap.before`:

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
  "locale": "en"
}
```

If the underlying conversation changed, Regenic rejects the stale `read_epoch`; run `search_conversations` again instead of combining old and new evidence.

## Agent guidance

1. Treat search hits as anchors, not as complete answers.
2. Keep `event_id` and `content_hash` with every factual citation.
3. Read continuations when `truncated` is true and the omitted area can affect the answer.
4. Do not interpret absence from conversation context as a negative business fact.
5. Query the authorized business system for current status before making customer-facing claims.

The server exposes read-only context tools. It does not grant new authorization, execute business queries, approve drafts, or send messages.
