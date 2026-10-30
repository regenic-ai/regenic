# @regenic/connector-contract

Types and pure helpers a Regenic connector compiles against: drivers, poll options, ingest records, credentials refs, and local probes.

```ts
import { channelRecord, type ChannelDriver } from "@regenic/connector-contract";
```

Install it with `@regenic/plugin-host`. The kernel, authority store, and blob store are not part of this package.

Requires Node.js 20 or newer.

## Installation lifecycle (in-process drivers)

Drivers owning local processes or long-lived collection opt in with
`ChannelDriver.stopInstallation`. Both hooks are optional, so drivers without
`stopInstallation` keep their existing behavior and identity:

```ts
startInstallation?(
  installation: ConnectorInstallation,
  host: ConnectorHost,
): Promise<void>;

stopInstallation?(
  installation: ConnectorInstallation,
  host: ConnectorHost,
  context: ConnectorStopContext,
): Promise<void>;

// Exported types:
type ConnectorStopReason =
  | "disable" | "delete" | "reconfigure" | "clear" | "shutdown";
interface ConnectorStopContext {
  reason: ConnectorStopReason;
  signal: AbortSignal;
}
```

`startInstallation` runs once before the first asynchronous operation of an
enabled installation's activation. Concurrent first calls await the same start.
It is not called by catalog/probe/field-option enumeration, installation
validation, capability checks, or synchronous queue reads. Metadata methods must
not start processes. A synchronous `waitThread` subscription falls back to
polling until start completes. A failed start is reported, not silently retried;
disable and re-enable to create another activation.

| Transition | Ordering |
| --- | --- |
| Disable | Fence new calls, abort polls, drain admitted calls and host stream/catalog/webhook work, await stop, then persist disabled status. |
| Delete | Same fence/drain/stop, then delete the installation and its snapshots. Deleting a missing installation remains idempotent. |
| Reconfigure | Validate first, stop with the old installation/config, then persist secrets/config. The next enabled operation starts a new activation. Stale pre-update snapshots cannot reactivate it. |
| Enable | After a successful stop, open a fresh activation; start is lazy. Repeated enable does not start twice. |
| Store clear | Stop all installations before clearing operational data; run legacy `onStoreClear` cache cleanup afterward, then reopen admission. Installations/config/credentials remain, so enabled installations may lazily collect again. Failed stop prevents the data reset. |
| Shutdown | Close all admission and abort polls, stop installations in parallel before disposing host services. Cleanup is bounded to 10 seconds per installation and an 11-second aggregate connector-shutdown deadline. |

Management mutations are serialized within one registry; runtime admission and
draining are per installation. Returned streams, sync sources, webhook handlers
and egress adapters, and resources registered through the supplied host (including
nested plugins), share the same activation fence. Poll cancellation combines the
caller's signal with the installation's signal. Returned methods retain their
original `this`. Old resource references and late asynchronous registrations stay
fenced even after re-enable. A successful stop also releases host-tracked stream,
egress and wait subscriptions. Host-side create/seed ingestion, reply/forward
delivery persistence and reply recovery also hold installation work leases, so a
driver callback returning does not let reset overtake the remaining storage work.
Keep resource creation inside installation runtime
operations and use the supplied host; out-of-band global process creation cannot
be managed by this lifecycle.

Stop runs once per activation, including when a disabled installation is later
deleted or shut down. Overlapping stops share one pending stop. Rejected or
timed-out attempts remain fenced and can be retried; they do not count as a
successful stop. Drain receives half the remaining budget; even if drain times
out, the host still attempts stop with the remaining budget. The stop signal is
aborted at the deadline or on completion. Drivers must honor it and perform
bounded termination/kill escalation. The host cannot forcibly terminate arbitrary
JavaScript or a child whose handle only the driver owns.

A stop rejection maps to HTTP 502 `lifecycle_failed`; a drain/stop timeout maps to
HTTP 504 `deadline_exceeded`; runtime calls through a stopped/stale activation
report `disabled` (409 when exposed by the API). Disable/delete/config mutations
are not committed on stop failure, preserving the installation needed to retry.
Enable cannot bypass an incomplete stop. A late stop resolution does not reopen
admission, and a still-pending timed-out stop cannot overlap a new activation.
Shutdown logs and aggregates failures while still attempting host disposal.
Legacy `onStoreClear` cache cleanup remains best-effort, with failures logged;
it is not a substitute for the pre-reset stop hook.

Stopping means **local collection and owned process shutdown only**. It must not
log out of the remote platform, revoke linked devices, erase device/session
credentials, or destroy user account data. Those require a separate explicit
user operation. Re-enable must work with retained credentials.
