# Collaboration Platform Source Intake

- **Chinese:** [../zh/COLLABORATION_PLATFORM_SOURCE_INTAKE.md](../zh/COLLABORATION_PLATFORM_SOURCE_INTAKE.md)
- **Related:** [Context platform integration architecture](CONTEXT_PLATFORM_INTEGRATION.md)
- **Status:** Required input before a vendor-specific adapter

Use this intake for Teamily or another collaboration/Agent platform. Complete it
with a real export or approved API sample before proposing a source adapter.

## Required Artifacts

1. A sanitized representative export or API response covering a conversation,
   thread, human message, agent message, document/workflow result, edit, and
   delete when supported.
2. The permission model: exporter identity, workspace/project scope, data
   ownership, and consent required to export or publish evidence.
3. Pagination and ordering semantics, including whether cursors are stable,
   opaque, expiring, or replayable.
4. Rate-limit, retry, webhook verification, and retention/deletion behavior.

## Mapping Worksheet

| Source concept | Sample field | Canonical destination | Required decision |
| --- | --- | --- | --- |
| Workspace / project |  | `org_id` / scope | Authority and consent boundary |
| Conversation / channel |  | `scope.id`, `scope.name` | Stable external identity |
| Message / object |  | `external_id` | Stable across export and replay |
| Thread / parent |  | `thread`, `parent_external_id` | Root and reply semantics |
| Human / agent actor |  | `actor` + `attrs` | Actor provenance; never authority by label alone |
| Source time |  | `occurred_at` | Timezone and update ordering |
| Content / artifact |  | `content` | Media type, bytes, text, external locator |
| Edit |  | `operation: revise` | Revision identity and predecessor rule |
| Delete / recall |  | `operation: tombstone` | Tombstone timing and retained evidence |
| Page marker |  | `next_cursor` | Commit condition and replay behavior |

## Adapter Acceptance

- Same source occurrence maps to the same `(source, external_id)`.
- Edits and deletes preserve their source identity and ordering rules.
- Agent turns retain platform, actor, conversation, and source-time provenance.
- Unsupported or incomplete source records quarantine without exposing body data.
- Polling adapters pass the Regenic conformance suite.
- Published Evidence Bundles are purpose-bound and exclude credentials, raw
  payloads, uncommitted records, and Blob bodies.