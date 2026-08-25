# RFC 0009 — Record class, thread facet, hosted execution

- **Status:** Accepted
- **简体中文:** [../../zh/rfcs/0009-work-orchestration.md](../../zh/rfcs/0009-work-orchestration.md)
- **Depends on:** RFC 0004, RFC 0005, RFC 0008, connector contract
- **Related:** [MESSAGE_ORCHESTRATION](../MESSAGE_ORCHESTRATION.md) · [CONNECTOR](../CONNECTOR.md)

## 1. Problem

The personal console must ingest N channels and host handling across ordinary messages, agent turns, and tickets. Labeling a **connector install** as human-chat or agent collides when one Feishu install carries groups, bots, and approvals. That path ends in per-channel branches.

Execution runtimes (DSH, Cursor, a private Agent OS) must not be welded into the kernel. The public build must not depend on a private project.

## 2. Goals

1. Classify **records** and **kernel projections**, never the connector install.
2. Connectors translate into a closed `record_class`. Unknown native types are quarantined; they are never silently mapped to `message`.
3. A `WorkItem` is a policy projection, not a third message type.
4. Execution is a `TaskExecutor` plugin. The kernel speaks only the port.
5. List membership stays current work. Sort can switch between `attention` and pin + recency.

## 3. Non-goals

- A DAG / skill-graph / model router inside this system.
- Shipping a private Agent OS in the default open-source tree.
- Team Jira (portfolios, sprints, assignment).
- Bumping `IngestBatch.schema_version`.

## 4. Layers

Meaning is peeled off the wire in fixed steps. L0 knows one protocol. L2 is what every channel shares. L5 is optional. L6 is a plugin.

```text
L0 protocol plugin    ChannelConnector / ChannelDriver / Egress
                      Feishu / Slack / CRM / DSH wire only
L1 envelope           IngestRecord
                      identity, time, author, body, idempotency
L2 record class       utterance | task | status | prompt
                      the shared vocabulary across N channels
L3 speaker            kind + direction on utterance only
                      user | assistant | system
L4 thread facet       chat | agent | ticket
                      kernel projection; optional per-record hint
L5 handling           WorkItem, opened by policy, optional
L6 execution          TaskExecutor plugin
                      DSH / Cursor / internal; kernel speaks the port
```

Tests do not import channel names across seams: connector tests lock L1/L2; kernel tests lock L4/L5; executor tests lock L6.

| Layer | Owns | Must not |
| --- | --- | --- |
| L0 | Native API, tokens, stream cursors, wire types | Write Event / Blob; label the **install** as chat or agent |
| L1 | `source` + `external_id`, `occurred_at`, author, body, content hash | Channel-native ids in the kernel (`om_`, `rpcId`) |
| L2 | Closed `record_class` mapped from `IngestRecord.type` | Silent map of an unknown native type to `message` |
| L3 | `kind` / `direction` on `utterance` | Treat `task` / `status` / `prompt` as a speaker |
| L4 | `thread_facet` from a task head, `await_reply` / prompts, or a hint | `if (source === "dsh")` in the kernel or desktop |
| L5 | Open or update a WorkItem when `task` or a Recipe matches | A third message type; a second list row for the bound executor session |
| L6 | `start` / `resume` / `status` through `ExecutorContext` | Import a private runtime into `@regenic/domain` or the default desktop |

Worked path (same Feishu install, three native facts):

| Native fact | L2 | L3 | L4 | L5 | L6 |
| --- | --- | --- | --- | --- | --- |
| Person in a DM | `utterance` | `user` | `chat` | none unless a Recipe matches | — |
| Bot in a group | `utterance` | `assistant` | `chat` | none | — |
| Approval / work unit | `task` | — | `ticket` | WorkItem | matched executor if a Recipe allows |

Agent and status paths:

| Native fact | L2 | L3 | L4 | L5 | L6 |
| --- | --- | --- | --- | --- | --- |
| DSH user turn | `utterance` | `user` | `agent` | optional Recipe | `dsh` when the Recipe says so |
| DSH `working` | `status` | — | not a list face | updates the bound Run | — |
| Mux / live question | `prompt` (not stored as Event) | — | `agent` | `waiting_human` | resume after `POST /v1/me/conversations/prompts` |

`assistant` utterances and `thread_status` records must not always become `current_work`. List membership is still current work. A WorkItem is extra handling on that thread, not another inbox row.

## 5. Record class

```ts
type RecordClass = "utterance" | "task" | "status" | "prompt";
```

| Value | Meaning | Persistence |
| --- | --- | --- |
| `utterance` | Someone said a line (human or assistant) | Event |
| `task` | A work unit with a lifecycle | Event |
| `status` | Invisible labor / `working` | Event (not a list face) |
| `prompt` | A live pending decision | Not stored (RFC 0008) |

Map from `IngestRecord.type`: `task` → `task`; `thread_status` → `status`; `prompt` → `prompt`; `message` / `thread_reply` / missing → `utterance`. An unknown native type is not mapped; it is quarantined and does not open a WorkItem. A connector may hint `thread_facet` on the surface. It must not stamp the install as a lane.

A Recipe with an empty `match` does not match any subject. At least one of `thread_id`, `source`, `record_class`, or `thread_facet` is required.

## 6. Speaker

Speaker is `kind` plus `direction`, and only applies to `utterance`:

| `kind` | Meaning |
| --- | --- |
| `user` | A person (including a person inside an agent session) |
| `assistant` | A bot or model turn |
| `system` | Runtime injection, not a chat bubble |

A bot in a human group is `utterance + assistant` on a `chat` thread. A person talking to an agent is `utterance + user` on an `agent` thread. Those two facts must not be collapsed into “this connector is Agent.”

## 7. Thread facet

```ts
type ThreadFacet = "chat" | "agent" | "ticket";
```

The kernel projects per record (a connector may hint; the hint is not an install attribute):

1. `record_class = task` → `ticket`
2. Else a per-record hint → use the hint
3. Else live prompts on that head → `agent`
4. Else → `chat`

`await_reply` / `list_title` / `hydrate_on_open` / `attention` / `receipts` stay protocol capabilities (RFC 0008), not facet labels. A capability is not a type.

## 8. WorkItem / Recipe / Run

```ts
type WorkItemStatus =
  | "open" | "running" | "waiting_human" | "done" | "failed" | "skipped";

interface Recipe {
  id: string;
  org_id: string;
  name: string;
  match: {
    record_class?: RecordClass;
    thread_facet?: ThreadFacet;
    source?: string;
    thread_id?: string;
  };
  executor_type: string;
  executor_config: Record<string, unknown>;
  can_write_back: boolean;
  enabled: boolean;
}

interface ResultEnvelope {
  summary: string;
  content?: ContentPart[];
  evidence_event_ids?: string[];
}
```

Identity is three objects (POSIX session / job / inferior):

| Object | Meaning | Not |
| --- | --- | --- |
| Session | Source conversation; list face | Work item primary key |
| Job (`WorkItem`) | One work unit, `unit_key` | One item for the life of a thread |
| Inferior (`WorkRun`) | One execution; sysout stays off the list by default | A user-opened agent chat |

Open a work item when `record_class = task`, or a Recipe satisfies the auto-start Specification (`thread_id`, or `record_class=task`, or `source` plus a non-utterance class). Empty, source-only, utterance-only, and facet-only matches do not auto-start.

A finished job plus a new `head_event_id` opens a **new** job. The list face is the current foreground job.

`can_write_back` is required for egress. Seeing a digest is not send grant.

`executor_config` belongs to the plugin. It is not a kernel field.

## 9. TaskExecutor

```ts
interface TaskExecutor {
  readonly executor_type: string;
  capabilities(): { start: boolean; resume: boolean; status: boolean; prompts?: boolean };
  catalog(): ExecutorCatalogEntry;
  start(input, ctx): Promise<ExecutorRunHandle>;
  resume(input, ctx): Promise<ExecutorRunHandle>;
  status(run, ctx): Promise<ExecutorRunHandle>;
}
```

The kernel looks up `ctx.executors`. The executor reaches the channel only through `ExecutorContext` (`spawnSysout` / `writeStdin` / `listPrompts` / `readTranscript`). It does not import a private HTTP client.

Completion is `WaitStatus` (wait / notify), orthogonal to transcript. Reading a chat bubble must not complete a run. Public DSH is absentee: without notify it stays running until a human `POST /v1/me/work-items/:id/complete` (session leader reaps). Write-back happens only on explicit `exited`.

Public default: `dsh`. Cursor later. A private Agent OS is an internal plugin package; the default open-source tree does not register it.

Suspend maps to Thread Surface prompts. Answers use `POST /v1/me/conversations/prompts`, never egress. Prompts on a bound inferior decorate the source session row.

## 10. List

Membership: current work, plus threads whose work item is `open` / `running` / `waiting_human`.

Sort (`ui_prefs.inbox_sort`):

- `normal`: pin → recent activity
- `attention`: `waiting_you` → `needs_ack` → `running` → `unread` → `quiet`; same rank by time. Running rows do not jump on status ticks and do not set unread.

The desktop reads `record_class`, `thread_facet`, `attention`, and `work`. Recipes have their own page: bind a task class, a source plus task, or one conversation, then Start run / Mark done on Current work. The desktop does not classify chat / agent / ticket by connector name.

## 11. Personal API

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/v1/me/inbox` | Also `record_class`, `thread_facet`, `attention`, `work` |
| GET/POST | `/v1/me/recipes` | List / create |
| POST | `/v1/me/recipes/:id` | Update |
| DELETE | `/v1/me/recipes/:id` | Delete |
| GET | `/v1/me/executors` | Mounted executor catalog |
| POST | `/v1/me/work-items/:id/run` | Manual start |
| POST | `/v1/me/work-items/:id/complete` | Human reap; may write back |
| GET/POST | `/v1/me/prefs` | `inbox_sort` |

## 12. Acceptance

1. Kernel and desktop never classify chat / agent / ticket by connector name.
2. Default open-source build has no private Agent dependency.
3. Swapping an executor is a plugin + Recipe choice.
4. Sort mode persists across refresh.
5. A source task is one list row; machine progress lives on that row.
6. A connector test may name Feishu or DSH. A kernel test of L4/L5/L6 may not.
