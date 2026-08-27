# Executors

An executor is an in-process plugin. It takes a work item the kernel opened,
runs one turn on a local connector or a remote HTTP runtime, and returns
`WaitStatus`.

This document describes the executor API and the install contract. Types
are defined in `@regenic/domain`. For layers, see
[Message orchestration](MESSAGE_ORCHESTRATION.md) and
[RFC 0009](rfcs/0009-work-orchestration.md).

This page is for people who implement or install an executor.

- **简体中文:** [../zh/EXECUTOR.md](../zh/EXECUTOR.md)
- **Related:** [Connectors](CONNECTOR.md) ·
  [Message orchestration](MESSAGE_ORCHESTRATION.md) ·
  [Desktop](../zh/DESKTOP.md) · [RFC 0009](rfcs/0009-work-orchestration.md)
- **Status:** Phase 1

## What an executor is

The kernel only sees the `TaskExecutor` port. It does not read
`Recipe.executor_config` keys, does not branch on connector names, and the
default open-source tree does not import private HTTP.

A connector is not an executor. A connector stops at L0: it translates one
channel's wire. An executor is L6: it runs a job. The same plugin package
may mount both a `ChannelDriver` and a `TaskExecutor` (DSH already does).
Swapping an executor is an installation (or plugin) plus a Recipe choice.

Capabilities are declared on the installation and on `catalog()`. The
kernel does not infer them from the driver name.

## Interfaces

| Interface | Responsibility |
| --- | --- |
| `TaskExecutor` | `start` / `resume` / `status`, plus the invoke catalog |
| `ExecutorContext` | The only way to touch a channel: `spawnSysout` / `writeStdin` / `listPrompts` / `readTranscript` |
| `ExecutorInstallation` | A first-class Engine install, next to connectors |

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

## Requirements

Each executor must:

- Implement `catalog()`. The Recipes page only renders those fields. The
  kernel stores `executor_config` as an opaque bag.
- Touch a channel only through `ExecutorContext`. A local binding must not
  ship a private HTTP client.
- Use `WaitStatus` (wait / notify) as the completion contract. Words in a
  bubble are not exit.
- Read credentials from environment variables, or from a name that points
  at one. The install form does not accept tokens.
- Fail independently. One install must not stall another.

The following are not allowed:

- Importing a private runtime into `@regenic/domain` or the default desktop.
- `if (executor_type === "dsh")` in the kernel or desktop, or classifying
  by connector name.
- Storing tokens in `config`, or returning them from `/v1/me`.
- Treating dismiss as `exited`, or writing back before a real exit.
- Special-casing invoke fields on the Recipes page by executor name.

## Install kinds

Engine manages executors separately from connectors.
`GET /v1/me/engine` `executor_catalog` declares the kind, fields, and this
document. The desktop only renders the catalog. It does not hard-code a
form per kind.

| `kind` | Meaning | Runtime |
| --- | --- | --- |
| `local_connector` | Pin to an installed connector that can `create` | `spawnSysout` uses that installation. An empty pin still picks the first creatable connector for `catalog.source` |
| `http` | Generic HTTP adapter | `POST {base}/v1/runs`, `GET /v1/runs/:id`, `POST /v1/runs/:id/resume` |

Credentials are the environment variable name `auth_env` only. The form
does not accept a token.

If there is no executor row yet, the kernel writes a local binding with
id `dsh`. Existing recipes keep `executor_type: "dsh"`.
`GET /v1/me/executors` lists invoke catalogs of **enabled** installations
only.

A DSH install with a `session_id` reports `create: false` and cannot be a
local executor.

## HTTP contract

A remote executor implements these three calls. The kernel forwards
`executor_config` as-is and does not read the keys.

| Method | Path | Request | Success |
| --- | --- | --- | --- |
| POST | `/v1/runs` | `work_item_id`, `thread_id`, `recipe_id`, `evidence_text`, `executor_config` | `external_run_id`, `status`, optional `agent_thread_id` / `prompts` / `result` |
| GET | `/v1/runs/:id` | — | Same |
| POST | `/v1/runs/:id/resume` | `work_item_id`, `recipe_id`, `answer` | Same |

`status` is `running` / `waiting_human` / `completed` / `failed` /
`cancelled`. Missing or unknown values are `failed`, so a job does not
stay running. The Bearer token comes from the environment variable named
on the install (`[A-Za-z_][A-Za-z0-9_]*`). Cloud metadata hosts are not
allowed as `base_url`.

## Invoke catalog

The Recipes “invoke” section is not a kernel field. Each enabled
installation's `TaskExecutor.catalog()` owns its form. The desktop only
renders `GET /v1/me/executors`.

```ts
interface ExecutorCatalogEntry {
  executor_type: string;
  label: string;
  description?: string;
  params_label?: string;
  source?: string;
  attach?: AttachMode;
  installation_id?: string;
  kind?: "local_connector" | "http";
  fields: ExecutorCatalogField[];
}
```

Building stdin, HTTP, or an agent target is the plugin's job. DSH uses
`skill` / `prompt`. Cursor and a private Agent OS declare their own
fields. An old DSH `instruction` maps to `prompt` only inside the DSH
plugin.

## Catalog

`GET /v1/me/engine` returns `executor_catalog`. The Engine page opens a
dialog for those fields on Install. A new kind adds an entry there.

| Field | Description |
| --- | --- |
| `fields` | `key`, `label`, required, placeholder, `hint`, optional `options` |
| `docs` | R&D specs. The Engine page renders these once next to the Executors title and opens the GitHub page |

Tokens are prerequisites, not form fields.

## Completion and write-back

Public DSH absentee notify is durable `turn/end` (an unclosed `turn/start`
or `working` stays running), or a gone session. The kernel reaps the job
on `exited`. Write-back happens only on that real exit, and only when the
Recipe has `can_write_back`. The kernel matches the first result line
exactly to a live prompt option. Aliases come from
`ChannelDriver.writeBackLabels`, not a host list.

Humans may `POST /v1/me/work-items/:id/dismiss` to drop a job from
current work. Dismiss is not `exited` and does not write back. The
abandoned inferior is `cancelled`. A later status tick must not resurrect
that run.

Humans answer prompts at `POST /v1/me/conversations/prompts`. Do not send
those answers through egress.

## Out of scope

- Implementing a DAG / skill graph / model router in this system
- Writing a private Agent OS into the default open-source tree
- Team portfolios, sprints, or multi-person assignment
