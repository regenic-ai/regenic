# Product

- **简体中文:** [../zh/PRODUCT.md](../zh/PRODUCT.md)
- **Related:** [message orchestration](MESSAGE_ORCHESTRATION.md) · [ROADMAP.md](ROADMAP.md) · [personal → org](rfcs/personal-to-org.md) · RFCs 0001–0007

## Overview

Regenic is a message orchestration layer for people and organizations.

It does not produce chat, mail, tickets, docs, or posts. Those remain in the channels where they were written. Regenic connects to that traffic. A workday in many groups can mean thousands of messages. Shared judgment standards and personal habits put the ones that need handling into a **message console** shared by humans and agents, and leave the rest outside the current work. A serious anomaly, or a message that has entered the current workflow, still reaches the console. Replies go back to the original channel.

Access control and judgment standards stay in the kernel.

Regenic sits under existing conversation and agent tools as an evidence and processing layer. See [Context platform integration](CONTEXT_PLATFORM_INTEGRATION.md).

| Stage | Meaning |
| --- | --- |
| Connect | Slack, mail, tickets, files, agent turns → one message format |
| Filter | Drop noise; respect ACL / personal boundaries |
| Rank | Durability, sensitivity, “need to know” (Event / Blob / Digest / Standard) |
| Distill | Evidence-backed claims, digests, follow-up signals |
| Dispatch | Against a versioned standard and personal habits: what needs handling goes to the console; the rest stay outside the current work |
| Send | Reply back to the original channel |
| Iterate standards | Gaps → proposals → versioned judgment standards (RFC 0001) |

## Capabilities

1. **Judgment standards** — encode, apply, and revise ranking and dispatch rules
2. **Shared context** — the same decision sees the same facts, with provenance

Channel traffic feeds these two. Method source: [regenic-ai/regenic-book](https://github.com/regenic-ai/regenic-book).

## Personal, then Org

| Edition | Scope |
| --- | --- |
| **Personal (now)** | One principal; authority on the machine |
| **Org (later)** | Canonical events + projections across people |

Personal ships first so one person can connect a channel, dispatch work, and optionally reply. Org uses the same message format ([personal → org](rfcs/personal-to-org.md)).

## Personal edition

1. **Local authority** — the device or self-hosted store is source of truth.
2. **Optional remote history** — off by default; a user-controlled cold copy; not the org database.
3. **Open export** — Markdown / JSON(L); data stays portable.
4. **Existing channels** — Slack stays Slack. Regenic reads from and writes back to those apps; it does not replace them.
5. **Not a notes product** — no outliner or bi-directional note graph in Phase 1.
6. **Console is a workbench** — the default view is what needs handling now, not every channel’s firehose.

## Out of scope

- Replacing the apps where messages are already written
- A general knowledge base or docs suite
- Generic ERP modules
- Treating personal AI labels as org truth without an org distill job
- Rebuilding another product’s messenger, studio, public feed, or model router
- Unbounded agent loops without standards and context

## RFC map

| Idea | Primary RFCs |
| --- | --- |
| Connect + layer + GC | 0005 |
| Facts / snapshots | 0002 |
| Standards / dispatch rules | 0001, 0007 |
| Collaboration / handoff | 0003 |
| Console + agents, same API | 0004 |
| ACL / non-escalation / send privilege | 0006 |

Personal orchestration ships first, then Org. See [ROADMAP.md](ROADMAP.md). Accepted RFCs are the shared target schema.
