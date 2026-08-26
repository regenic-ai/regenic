# Message orchestration

- **简体中文:** [../zh/MESSAGE_ORCHESTRATION.md](../zh/MESSAGE_ORCHESTRATION.md)
- **Related:** [PRODUCT.md](PRODUCT.md) · [CONNECTOR.md](CONNECTOR.md) · [INGESTION_ARCHITECTURE.md](INGESTION_ARCHITECTURE.md) · [TECH_STACK.md](TECH_STACK.md) · RFC 0004, 0005, 0006, 0008, [0009](rfcs/0009-work-orchestration.md)
- **Status:** Public architecture for Phase 1+

Regenic orchestrates **messages**. It does not host the apps where those messages were written.

## Layers

Channel wire, shared meaning, and execution stay on separate layers. Contract: [RFC 0009](rfcs/0009-work-orchestration.md).

```text
L0 protocol plugin    Feishu / Slack / CRM / DSH wire only
L1 envelope           IngestRecord: identity, time, author, body, idempotency
L2 record class       utterance | task | status | prompt     ← shared across N channels
L3 speaker            utterance only: user | assistant | system
L4 thread facet       kernel projection: chat | agent | ticket
L5 handling           policy may open a WorkItem (optional)
L6 execution          TaskExecutor plugin (DSH / Cursor / internal)
```

A connector install is L0. It is not a lane. One Feishu install can emit a DM (`utterance` + `user` + `chat`), a group bot (`utterance` + `assistant` + `chat`), and an approval (`task` + `ticket`) on the same wire. The kernel projects L4. Policy opens an L5 Job only for a `task` or a Recipe that satisfies the auto-start Specification. A session may have many jobs; the list shows the foreground face. Most chat never becomes a WorkItem.

Speaker (L3) applies only to `utterance`. A person inside an agent session is still `user`. A bot inside a human group is still `assistant`. Those facts do not move to the install.

L6 reaches the channel only through `ExecutorContext` (`spawnSysout` / `writeStdin` / `readTranscript`). Completion is `WaitStatus`, not a chat bubble. The default open-source tree mounts absentee `dsh`. Cursor follows. A private Agent OS stays an internal plugin package.

Kernel and desktop read `record_class`, `thread_facet`, `attention`, and `work`. They do not classify chat / agent / ticket by connector name.

## Message flow

A human or an agent should not need to know whether a thread arrived from mail, a chat workspace, an internal ticket system, or a file. Incoming traffic is normalized into one message format and stored as Event and Blob. Replies go back to the original channel.

```text
channels
        |  connector (read)
        v
   unified message → Event + Blob
        |
        v
   kernel
   filter → layer → rank → dispatch
        |
        +-- rest → outside current work
        +-- needs handling → message console (human + agent, same API)
                |
                v
           reply
                |  connector (send)
                v
           original channel
```

Receive and send are not the same privilege:

- **Receive** is processing. Distillation must not raise access (RFC 0006).
- **Send** is a grant. Seeing a digest does not grant `can_send`.

## Message console

The console is the human/agent surface of orchestration:

- Default view is what needs handling now
- The rest never appear
- Thread window around an Event, not an isolated snippet
- Provenance is a lookup
- Humans and agents use the same `/v1` resources (RFC 0004)

Conversations do not live in the console. Replies go back to the original channel.

## Plugins

Connectors, models, and stores attach as **plugins** (a port plus a driver). A running process is a plugin tree assembled by `@regenic/plugin-host`. New channel or model support is added by mounting a plugin, not by patching a privileged core. Unloading a plugin disposes its fiber: registry rows, listeners, and open stores unwind with it. No leftover writes, no leftover grants.

Capabilities are looked up by `ctx` key, not by importing a driver:

| `ctx` key | Port |
| --- | --- |
| `authority` | `AuthorityStore` plus connector runtime |
| `blobs` | `BlobStore` |
| `ingest` | Ingest service (the only Event / Blob writer) |
| `connectors` | Registry of mounted `ChannelConnector`s |
| `egress` | Registry of mounted `EgressAdapter`s |
| `executors` | Registry of mounted `TaskExecutor`s |

**Kernel**

- Message format and idempotency
- AuthorityStore / BlobStore writes
- ACL `visible()` and authority boundaries
- D0 filter and layer: `current_work` / `outside_current_work` / `pending`; the Event stays; never auto-defer
- Standards application and revision hooks
- Dispatch: outside current work vs pending
- Audit of reads and sends

**Plugin kinds**

| Kind | Responsibility | Must not |
| --- | --- | --- |
| Connector (`ChannelConnector`) | Read a source into `IngestBatch` | Write Event, Blob, ACL, or identity |
| Channel driver (`ChannelDriver`) | Install, resolve pull streams, bind egress, declare sync / reply / create | Patch API / UI with per-channel switches |
| Send (`EgressAdapter`) | Write a reply to the original channel | Mint extra privileges or skip approval |
| Ranker / layer | Scoring after D0 (durability, sensitivity, “need to know”). D0 filter/layer is kernel | Promote personal labels to org truth |
| Dispatcher policy | Map rank + standard + habits → outside current work \| pending \| defer | Send without a send grant |
| Model | Propose only | Own scoring, quota, or ACL |
| Executor (`TaskExecutor`) | Run one Job from a Recipe; public absentee DSH, other agents later | Complete from transcript; classify by connector name; weld a private runtime into the kernel |
| Identity / secrets / search / notify | Fill a capability seam | Change the message format |

Each seam has a definition, a provider, and consumers. Swapping one connector for another must not fork the kernel. Adding a source later is a plugin, not a rewrite.

Connectors follow the [connector contract](CONNECTOR.md). They translate; the ingest service validates, authorizes, deduplicates, stores, and audits. See [INGESTION_ARCHITECTURE.md](INGESTION_ARCHITECTURE.md).

## Message contract

Send and display shape live in `@regenic/domain` `message-contract`. The connector implements that contract; the desktop does not invent role rules. Implementer rules, ports, and current drivers are in [CONNECTOR.md](CONNECTOR.md).

Connectors ingest through `channelRecord()` so surface metadata travels with the body. Legacy events without it fall back to `inferLegacySurface()`. A local outbound and the channel-history echo of the same utterance stay a single Event.

Reply, follow, pull, and new conversations go through `ChannelDriverRegistry`: `installation + thread → driver.resolveStreams / bindEgress / createThread`. `ownsThread` wins over a catch-all match. Follow and live pull share one queue per stream. The desktop asks `can_send`, `can_create`, `await_reply`, `list_title`, and `activity`, not “is this DSH?”.

## Extension points

| Goal | Mechanism |
| --- | --- |
| Add a source | [Connector contract](CONNECTOR.md); conformance tests |
| Add a send path | Same channel, send enabled |
| Change what counts as important | Ranker plus a versioned standard |
| Auto-handle ordinary mail | Dispatcher policy bound to a standard; those messages stay outside the current work and every skip is audited |
| Stop when unsure | Defer; defer is never an answer |
| Agent read | Evidence Bundle / console API; no credentials |
| Agent send | Explicit send grant |
| Swap SQLite for Postgres | `AuthorityStore` provider; message format unchanged |
| Add a model | `ModelProvider` plugin; propose only |
| Add an executor | `TaskExecutor` plugin + Recipe match; kernel stays on the port |

If a change needs a new field on `IngestBatch` or a new kernel invariant, it is not a plugin. Write an RFC.

## Composition

A running process is a **plugin tree** composed at boot (Personal defaults, then Org defaults). Personal and Org share the same message format and plugin kinds. Org adds identity mapping, canonical Event merge, and per-scope ACL. See [personal → org](rfcs/personal-to-org.md).

## Out of scope

- Replacing the apps where messages are already written
- A plugin marketplace before conformance tests exist
- Unbounded agent loops without standards and context
- Treating plugin output as authority without the kernel
