# Product positioning

- **中文:** [../zh/PRODUCT.md](../zh/PRODUCT.md)
- **Related:** [ROADMAP.md](ROADMAP.md) · [personal → org](rfcs/personal-to-org.md) · RFCs 0001–0007

## 1. What Regenic is

Regenic is an **information processing layer** for people and organizations.

It does **not** produce primary information (chat, tickets, mail, docs, metrics).
It **ingests** information (push or pull), then **processes** it so humans and
agents can judge and act under shared standards and shared context.

Processing includes (non-exhaustive):

| Stage | Meaning |
| --- | --- |
| Ingest | Connectors: webhook push, poll/pull, file import, agent turns |
| Filter | Drop noise; respect ACL / personal boundaries |
| Layer | Durability and sensitivity tiers (Event / Blob / Digest / Standard) |
| Distill facts | Claims, digests, “what you need to know” — evidence-backed |
| Iterate standards | Gaps → proposals → versioned judgment standards (RFC 0001) |
| Act / follow-up | Queues, handoffs, unreplied threads — **applications** of processing |

Inbox triage, “should know,” and unreplied ranking are **surfaces** of this
pipeline — not the product definition.

## 2. Dual-capability model

From the Regenic book:

1. **Judgment standards** — encode / apply / revise shared standards  
2. **Shared context** — same fact set for the same decision, with provenance  

Regenic turns channel traffic into inputs for those two capabilities.

## 3. Delivery sequence: Personal → Org

| Edition | Scope | Availability |
| --- | --- | --- |
| **Personal (now)** | One principal; local-first processing | Open source |
| **Org (later)** | Canonical events + projections across people | Open source |

Both editions are open source. A few optional modules for large-organization
deployments may live outside this repository; the core path here is
self-hostable without them.

Personal ships first so one person can run the full loop. Org builds on the
same object model with identity, policy, and multi-person canonicalization
([personal → org](rfcs/personal-to-org.md)).

## 4. Personal principles

1. **Local authority** — device or self-hosted store is source of truth.  
2. **Optional remote history** — user-controlled cold copy; off by default;
   not the org database.  
3. **Open export** — Markdown / JSON(L); data stays portable.  
4. **Pluggable ingest** — ChannelConnector for push and pull.  
5. **Not a note-taking product** — no outliner or bi-directional note graph
   as the Phase 1 core.

## 5. Non-goals (near term)

- Replacing Feishu / Slack / email as the message transport  
- Building a general knowledge-base or docs suite  
- Generic ERP modules  
- Treating personal AI labels as org ground truth without an org distill job  

## 6. Mapping to Accepted RFCs

| Processing idea | Primary RFCs |
| --- | --- |
| Ingest + layer + GC | 0005 |
| Facts / snapshots | 0002 |
| Standards iteration | 0001, 0007 |
| Collaboration / handoff | 0003 |
| Symmetric API | 0004 |
| ACL / non-escalation | 0006 |

[ROADMAP.md](ROADMAP.md) delivers Personal processing first, then Org.
Accepted RFCs define the shared target schema for both.
