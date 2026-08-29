# RFC 0009 — Record class, thread facet, hosted execution

- **Status:** Accepted
- **简体中文:** [../../zh/rfcs/0009-work-orchestration.md](../../zh/rfcs/0009-work-orchestration.md)
- **Depends on:** RFC 0004, RFC 0005, RFC 0008, connector contract
- **Related:** [MESSAGE_ORCHESTRATION](../MESSAGE_ORCHESTRATION.md) · [CONNECTOR](../CONNECTOR.md) · [EXECUTOR](../EXECUTOR.md)

## 1. Problem

The personal console must ingest N channels and host handling across ordinary messages, agent turns, and tickets. Labeling a **connector install** as human-chat or agent collides when one Feishu install carries groups, bots, and approvals. That path ends in per-channel branches.

Execution runtimes (DSH, Cursor, a private Agent OS) must not be welded into the kernel. The public build must not depend on a private project.

## 2. Goals

1. Classify **records** and **kernel projections**, never the connector install.
2. Connectors translate into a closed `record_class`. Unknown native types are quarantined; they are never silently mapped to `message`.
3. A `WorkItem` is a policy projection, not a third message type.
4. Execution is a `TaskExecutor` plugin. The kernel speaks only the port.
5. List membership stays current work. **Showing vs hidden** is a separate `conversation_prefs.hidden` surface — not derived from WorkItem status or tombstone. Sort can switch between `attention` and pin + recency.

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
  trigger: {
    kind: "push" | "pull" | "manual";
    interval_ms?: number;
    coalesce?: boolean;
  };
  executor_type: string;
  executor_config: Record<string, unknown>;
  can_write_back: boolean;
  include_context: boolean;
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

`match` must be specific (`thread_id`, or `record_class=task`, or `source` plus a non-utterance class). Empty, source-only, utterance-only, and facet-only matches cannot be saved.

`trigger` is first-class and separate from match:

| `kind` | When it runs | `unit_key` | Evidence |
|---|---|---|---|
| `push` | Ingested inbound user message or task | `event_id` | Trigger message; `include_context` optional |
| `pull` | Clock; requires `thread_id` + `interval_ms` | `pull:{recipe_id}:{next_run_at}` | Session context is the payload; write-back default on |
| `manual` | Current work → Start run only | Same as push | Same as push |

Push contract: outbound / assistant / this recipe’s own write-back do not fire; `(recipe, event)` is idempotent; `coalesce` defaults true: a running job does not steal `head_event_id`, and after exit one follow-up uses the latest head. `coalesce=false` opens a new job on a new head even while one is active. Execution failure stays on `WorkItem.failed` and retries at 30s / 2min / 8min, at most 3 times, counted by `WorkRun`. Connector loss stays at L0. A manual recipe may bind to a matching job but does not `start`.

Pull contract: not connector pull. Persist `next_run_at` so sleep and restart still fire. Skip if the previous occurrence is still running. A due recipe runs once, then `next_run_at` jumps to a future slot. The kernel still does not read `executor_config` keys.

The delivery ledger owns egress only, not start. A finished job that needs write-back enqueues a `payload` snapshot and a stable `idempotency_key`. The tick flushes `queued` and due `failed` rows. `write_back` holds a 60s lease and returns to `queued` when it expires. Channel send is capped at 45s; timeout does not fail the letter. A recorded `channel_receipt` skips a second send and only retries ingest. `applyHandle` enqueues; it does not `await` send. Dispatch, supervise, and flush hold separate locks so a stuck egress does not stall ingest or pull. `acked` / `dead` mean whether the channel got the result. Dismiss closes an open letter as `acked/skipped`. An empty body is not a successful skip. Desktop `attention` trusts the kernel face: `waiting_you` / `needs_ack` / `running` beat local unread.

A finished job plus a new `head_event_id` opens a **new** job. The list face is the current foreground job.

`can_write_back` is required for egress (on by default for pull). Seeing a digest is not send grant.

When `include_context` is true or `trigger.kind=pull`, start packs only a recent page of the source thread into evidence (capped by line and character count; overflow is marked omitted). It must not load thousands of messages into the kernel or the executor. Push defaults to only the triggering or head message. This is kernel evidence policy, not an `executor_config` key.

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

Completion is `WaitStatus` (wait / notify). The words in a bubble are not exit. Public DSH absentee notify is durable `turn/end` (unclosed `turn/start` or `working` stays running), or a gone session. The kernel reaps the job on `exited`. Write-back happens only on that real exit. The kernel matches the first result line exactly to a live prompt option. Aliases come from `ChannelDriver.writeBackLabels`, not a host list. Humans answer prompts; they may `POST /v1/me/work-items/:id/dismiss` to drop a job from current work. Dismiss is not `exited` and does not write back. The abandoned inferior is `cancelled`, not `failed`. A later status tick must not resurrect that run or write back.

Public default: a managed local `dsh` binding (seeded id `dsh`, so existing recipes keep working). Local L6 plugins register by `catalog.source`; the mount path does not write `if (source === "dsh")`. Cursor and a private Agent OS (for example bioby-agent) come later under the same catalog contract. A private runtime is an internal plugin package, or it is called through the generic HTTP executor. The default open-source tree does not import private HTTP.

Executors are first-class installations, next to connectors:

| `kind` | Meaning |
| --- | --- |
| `local_connector` | Pin to a connector installation that can `create`. `spawnSysout` uses that installation. An empty pin still picks the first creatable connector for `catalog.source` |
| `http` | Generic HTTP adapter. `POST {base}/v1/runs`, `GET /v1/runs/:id`, `POST /v1/runs/:id/resume`. Credentials are an env var name only |

Swapping an executor is an installation (or plugin) plus a Recipe choice. `GET /v1/me/executors` lists catalogs of **enabled** installations only. The kernel still never reads `executor_config` keys and never classifies by connector name.

### Invoke catalog

The Recipes “invoke” section is not a kernel field and not a fixed Prompt box. Each `TaskExecutor.catalog()` owns its form. The desktop only renders `GET /v1/me/executors`. The kernel stores `Recipe.executor_config` as an opaque bag and **never reads the keys**. Swapping an executor swaps the plugin and the fieldset. No `if (executor_type === "dsh")`.

```ts
interface ExecutorCatalogField {
  key: string;
  label: string;
  required?: boolean;
  placeholder?: string;
  default?: string;
  hint?: string;
  kind?: "text" | "textarea" | "select";
  options?: Array<{ value: string; label: string }>;
}

interface ExecutorCatalogEntry {
  executor_type: string;
  label: string;
  description?: string;
  params_label?: string;
  source?: string;
  attach?: AttachMode;
  fields: ExecutorCatalogField[];
}
```

Composing stdin, HTTP, or an agent goal is the plugin’s job. DSH uses `skill` / `prompt`. Cursor or bioby-agent declare their own repo, model, goal, or constraints. A legacy DSH `instruction` maps to `prompt` only inside the DSH plugin.

A connector is not an executor. One plugin package may register both an L0 `ChannelDriver` and an L6 `TaskExecutor` (DSH already does: Engine installs the channel, then an executor installation binds that channel or calls HTTP). Extra packages load in-process from `REGENIC_PLUGIN_DIR` / `REGENIC_CHANNEL_PLUGIN`; the kernel does not import their names. Out-of-process stays the generic HTTP executor — no extension host. bioby-agent attaches the same way. Private HTTP stays out of the kernel and the Recipes page.

Suspend maps to Thread Surface prompts. Answers use `POST /v1/me/conversations/prompts`, never egress. Prompts on a bound inferior decorate the source session row.

## 10. List

Shown vs hidden is a list-surface pref (`conversation_prefs.hidden`), not derived from tombstone / `work_acked` / WorkItem status. The default list is current work that is not hidden. `list=hidden` is the folded pile. A human fold stays put when new work arrives. A policy fold (finished or dismissed job, or a tombstone that leaves the thread off the desk) comes back when new `current_work` is accepted. The desktop filter writes `ui_prefs.inbox_list`.

Sort (`ui_prefs.inbox_sort`):

- `normal`: pin → recent activity
- `attention`: `waiting_you` → `needs_ack` → `running` → `unread` → `quiet`; same rank by time. Running rows do not jump on status ticks and do not set unread.

The desktop reads `record_class`, `thread_facet`, `attention`, and `work` (including `work.delivery`). The recipe page asks when to run first (new messages / schedule / manual), then scope and executor. Push and pull start on their own; Start run is for manual, retry, or run-now. On write-back failure or dead letter the same button retries delivery. Humans dismiss a job they do not want; they do not Mark done. The desktop does not classify chat / agent / ticket by connector name.

## 11. Personal API

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/v1/me/inbox` | Also `record_class`, `thread_facet`, `attention`, `work`; `list=shown\|hidden` |
| GET/POST | `/v1/me/prefs` | `inbox_sort`, `inbox_list` |
| GET/POST | `/v1/me/recipes` | List / create |
| POST | `/v1/me/recipes/:id` | Update |
| DELETE | `/v1/me/recipes/:id` | Delete |
| GET | `/v1/me/executors` | Enabled executor catalog |
| POST | `/v1/me/executors` | Install `local_connector` or `http` |
| POST | `/v1/me/executors/:id/config` | Rename or rebind |
| DELETE | `/v1/me/executors/:id` | Uninstall |
| POST | `/v1/me/executors/:id/enable` | Enable |
| POST | `/v1/me/executors/:id/disable` | Disable |
| POST | `/v1/me/work-items/:id/run` | Manual start |
| POST | `/v1/me/work-items/:id/dismiss` | Drop from current work; no write-back |
| POST | `/v1/me/work-items/:id/complete` | Alias of dismiss; does not fake `exited` |

## 12. Acceptance

1. Kernel and desktop never classify chat / agent / ticket by connector name.
2. Default open-source build has no private Agent dependency.
3. Swapping an executor is a plugin + Recipe choice. The Recipes invoke form renders only `catalog().fields` and does not special-case keys.
4. Sort mode persists across refresh.
5. A source task is one list row; machine progress lives on that row.
6. A connector test may name Feishu or DSH. A kernel test of L4/L5/L6 may not.
7. A job that needs write-back enqueues a payload snapshot. Sent or an explicit skip is `acked`. An expired lease returns to the queue. Three send failures become a visible dead letter. Execution failure is not a delivery row.
