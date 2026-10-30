# Customer-service Agent setup

Regenic can now turn an authorized customer message into a durable customer-service task. An Agent can retrieve bounded conversation evidence, submit an evidence-bound interpretation, query a scoped read-only business service, and create a customer-visible draft. A human must approve the draft in the desktop app before Regenic can send it.

## 1. Configure the business query service

Set these variables on the Regenic API/kernel process:

```powershell
$env:REGENIC_CUSTOMER_BUSINESS_URL = "https://business-tools.example.com/v1/customer-status/query"
$env:REGENIC_CUSTOMER_BUSINESS_TOKEN = "<secret>"
$env:REGENIC_CUSTOMER_BUSINESS_TIMEOUT_MS = "10000" # optional, 100-60000
```

The URL must use HTTPS. Loopback HTTP is allowed for local development. Credentials, query strings, and fragments are rejected in the configured URL.

Regenic sends:

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

The business service must enforce its own tenant/customer/project authorization, field allowlist, row limit, and read-only behavior. It returns only requested members and fields:

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

Result status is one of `found`, `not_found`, `ambiguous`, `permission_denied`, or `unavailable`. `not_found` never means “has not replied.” Use `complete: false` plus `next_page` when more rows remain. Customer-facing claims can use only fields marked `customer`.

## 2. Build the local Agent tool server

```powershell
pnpm --filter @regenic/local-cli... build
```

Add the following stdio MCP server to the target Cursor configuration. Use an absolute path to this checkout:

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

The key may be omitted only for a loopback kernel that does not require it. The MCP process accepts HTTPS or loopback HTTP API URLs. It exposes:

- `create_customer_task`
- `search_context`
- `read_context`
- `update_customer_brief`
- `query_customer_business`
- `create_customer_reply_draft`
- `get_customer_task`

It intentionally does **not** expose review or send tools. Conversation evidence cannot grant authorization, execute SQL, approve a draft, or send a message.

## 3. Agent workflow

1. Create a task from the current source Event ID and content hash.
2. Call `search_context`; use `read_context` when a continuation is returned.
3. Keep customer/project/batch/intent/member values unresolved or conflicting until citations support them.
4. Submit the brief. Every verified scope value requires a task-owned context citation, and every verified member requires both `evidence` and `identity_evidence`. The server enters `ready_for_query` only when the scoped IDs, closed member set, stable business IDs, requested fields, and remaining gaps are valid.
5. Query business data. Pagination must finish before a complete reply.
6. Create a draft with claim-to-business-evidence mappings and explicit member coverage.
7. A human reviews the task in **Customer tasks** in the desktop rail.
8. Regenic re-queries the business source before send. Changed facts invalidate approval and require a new draft/review. Existing reply idempotency prevents duplicate sends.

`include_related: true` can search other authorized conversations only after customer and project scope are verified. Returned matches remain evidence candidates; they do not change authorization by themselves.

## 4. Retrieve Agent-ready conversation context over HTTP

External applications should use the expanded search endpoint instead of treating search snippets as conversation history:

```http
POST /v1/me/context/search/expand
Content-Type: application/json
X-Regenic-Personal-Key: <personal API key>
```

```json
{
  "query": "Did both selected creators reply?",
  "limit": 10,
  "context": {
    "before": 4,
    "after": 4,
    "reply_depth": 8,
    "max_messages": 40
  }
}
```

Each returned conversation contains:

- `thread_id` for the conversation;
- `anchor_event_ids` for the search hits;
- message `event_id`, source-native `external_id`, `content_hash`, timestamp, actor, and text;
- `parent_external_id` and resolved `reply_to_event_id` when a reply relationship is available;
- `selection_reason` (`hit`, `reply_target`, or `neighbor`);
- `continuation.before`, `continuation.after`, and `continuation.gaps` boundaries when history was omitted;
- `truncated: true` whenever the returned messages are not a continuous complete local thread.

The server rechecks each hit against the current lifecycle head and content hash before expanding it. A `409 context_changed` response means the application must repeat the search. `limit` is capped at 20, message expansion is capped at 100, and `limit` cannot exceed `context.max_messages`.

“Complete” remains bounded: the endpoint returns all selected message bodies or fails explicitly, but it does not claim connector source sync is complete. Conversation evidence may identify business entities and intent; current business status must still come from the authorized business query service.

## 5. Operational boundaries

- Existing `/v1/me/context/search`, `/search/source`, and `/ask` behavior is unchanged. `/search/expand` is the Agent-oriented aggregation endpoint.
- Customer tasks, brief versions, business evidence, drafts, reviews, and send state persist in the Authority store.
- Clearing Regenic operational data also clears customer-service tasks.
- Local embeddings do not make a remote Cursor or business service local. Apply the deployment's outbound-data policy.
- The first release is read-only for business systems and always human-approved for customer sends.

See the [implementation proposal](../zh/AGENT_CONTEXT_RETRIEVAL_PROPOSAL.md) for rationale, completeness semantics, and acceptance criteria.
Run the [customer-service evaluation gate](CUSTOMER_SERVICE_EVALUATION.md) before changing retrieval or workflow safety behavior, then run the [system-level acceptance suite](CUSTOMER_SERVICE_SYSTEM_ACCEPTANCE.md) for MCP/API integration changes.
