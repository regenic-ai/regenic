# Message orchestration

- **简体中文:** [../zh/MESSAGE_ORCHESTRATION.md](../zh/MESSAGE_ORCHESTRATION.md)
- **Related:** [PRODUCT.md](PRODUCT.md) · [INGESTION_ARCHITECTURE.md](INGESTION_ARCHITECTURE.md) · [TECH_STACK.md](TECH_STACK.md) · RFC 0004, 0005, 0006
- **Status:** Public architecture for Phase 1+

Regenic orchestrates **messages**. It does not host the apps where those messages were written.

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
| Channel driver (`ChannelDriver`) | Install, resolve pull streams, bind egress for a thread, declare reply | Patch API / UI with per-channel switches |
| Send (`EgressAdapter`) | Write a reply to the original channel | Mint extra privileges or skip approval |
| Ranker / layer | Scoring after D0 (durability, sensitivity, “need to know”). D0 filter/layer is kernel | Promote personal labels to org truth |
| Dispatcher policy | Map rank + standard + habits → outside current work \| pending \| defer | Send without a send grant |
| Model | Propose only | Own scoring, quota, or ACL |
| Identity / secrets / search / notify | Fill a capability seam | Change the message format |

Each seam has a definition, a provider, and consumers. Swapping one connector for another must not fork the kernel. Adding a source later is a plugin, not a rewrite.

Connectors follow [INGESTION_ARCHITECTURE.md](INGESTION_ARCHITECTURE.md): they translate; the ingest service validates, authorizes, deduplicates, stores, and audits.

## Message contract (kernel defines, connectors implement)

Send and display shape live in `@regenic/domain` `message-contract`. Connectors only translate a channel into that contract. The desktop does not invent its own role rules.

| Kernel | Connector |
| --- | --- |
| Channel id / label (`dsh` → DSH, `slack` → Slack) | Emit that id as `source` |
| Display kind `user` / `assistant` / `system` | Map native events. DSH: `user/message` + `source.kind=user` → user; `assistant/message` text blocks → assistant; plugin-injected `user/message` → system. Slack humans → user |
| Direction `inbound` / `outbound` | Reads are inbound; console replies are outbound |
| Send envelope: `ContentPart[]` (`body` + `attachment`) | `EgressAdapter.send` writes back (DSH `session.prompt`) |

Connectors ingest through `channelRecord()` so a surface metadata part travels with the body. The console renders the channel tag and avatar from that surface. Legacy events without it fall back to `inferLegacySurface()`: `:out:` is local outbound, everything else is inbound assistant. The kernel does not guess from body text or `source === "dsh"`. A local outbound and the channel-history echo of the same utterance in one conversation stay a single Event.

Reply, follow, and pull go through `ChannelDriverRegistry`: the API only does `installation + thread → driver.resolveStreams / bindEgress → egress.send(ContentPart[])`. The desktop asks inbox `can_send`, not “is this DSH?”. A new channel is a driver, not a kernel or console branch.

## Extension points

| Goal | Mechanism |
| --- | --- |
| Add a source | Connector; conformance tests |
| Add a send path | Same channel, send enabled |
| Change what counts as important | Ranker plus a versioned standard |
| Auto-handle ordinary mail | Dispatcher policy bound to a standard; those messages stay outside the current work and every skip is audited |
| Stop when unsure | Defer; defer is never an answer |
| Agent read | Evidence Bundle / console API; no credentials |
| Agent send | Explicit send grant |
| Swap SQLite for Postgres | `AuthorityStore` provider; message format unchanged |
| Add a model | `ModelProvider` plugin; propose only |

If a change needs a new field on `IngestBatch` or a new kernel invariant, it is not a plugin. Write an RFC.

## Composition

A running process is a **plugin tree** composed at boot (Personal defaults, then Org defaults). Personal and Org share the same message format and plugin kinds. Org adds identity mapping, canonical Event merge, and per-scope ACL. See [personal → org](rfcs/personal-to-org.md).

## Out of scope

- Replacing the apps where messages are already written
- A plugin marketplace before conformance tests exist
- Unbounded agent loops without standards and context
- Treating plugin output as authority without the kernel
