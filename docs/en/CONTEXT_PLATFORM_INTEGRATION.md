# Context Platform Integration Architecture

- **Chinese:** [../zh/CONTEXT_PLATFORM_INTEGRATION.md](../zh/CONTEXT_PLATFORM_INTEGRATION.md)
- **Related:** [PRODUCT.md](PRODUCT.md) · [INGESTION_ARCHITECTURE.md](INGESTION_ARCHITECTURE.md) · RFC 0005, RFC 0006, RFC 0007
- **Status:** Direction for Phase 1 and Phase 2 delivery

## 1. Decision

Regenic is not a second messenger, collaborative studio, agent marketplace, or general Agent Operating System. It is the **evidence-backed context processing layer** beneath those products.

Human-AI collaboration platforms such as Teamily can be both an upstream source of conversations, agent turns, documents, and workflow outcomes, and a downstream context consumer that receives bounded, evidence-backed outputs.

Their conversational UX and agent orchestration remain their responsibility. Regenic owns evidence ingestion, versioning, provenance, boundary enforcement, processing state, and portable outputs.

## 2. Boundary

```text
Collaboration platforms / messaging / files / business systems
                         |
                         v
             Source adapter or file import
                         |
                         v
   Canonical Event + Blob + revision/tombstone + quarantine
                         |
                         v
   Evidence processing: digest, claims, standards, follow-up signals
                         |
                         v
       Context Consumer / Evidence Bundle boundary
                         |
                         v
      Teamily agents, workspaces, studios, or other applications
```

No upstream platform writes Event, Blob, Digest, Claim, or Standard records directly. No downstream agent receives uncommitted records, raw connector credentials, or data outside its evidence and ACL boundary.

## 3. Integration Contracts

### 3.1 Upstream source adapter

A platform adapter maps its export, webhook, or poll protocol to `IngestBatch`. It must preserve deterministic external identities and represent source edits and deletions as `revise` and `tombstone` operations. Agent-produced material is provenance, not authority: its source, external actor, conversation/thread, and source-time remain explicit.

The adapter must pass the poll connector conformance suite when it polls. File exports use the existing explicit mapping import path until a stable native export schema is available.

### 3.2 Evidence Bundle consumer

A future `ContextConsumer` port publishes a bounded bundle, not an unrestricted memory dump. A bundle contains selected Event IDs and content-hash references, approved Digest/Claim/Snapshot IDs when available, source/time/scope/evidence links, and the consumer principal with its allowed purpose.

It excludes connector tokens, raw webhook payloads, quarantined body content, and records not committed in the AuthorityStore. Consumers may propose work, but their outputs re-enter through an adapter and cannot self-certify as facts.

### 3.3 Processing state

The current local digest is a deterministic evidence index. It may expose Event operation counts and safe quarantine status, but it must not present model output as a fact without evidence links and an explicit lifecycle state.

## 4. Delivery Tasks

1. **Source contract discovery:** complete the [source intake](COLLABORATION_PLATFORM_SOURCE_INTAKE.md) with a representative Teamily export or API payload, permission model, pagination behavior, edits/deletes, and agent-turn identifiers. This is a hard input; do not infer a private protocol from product marketing material.
2. **Teamily export adapter:** add canonical fixtures and an import profile for the approved payload. Cover chat, thread, human/agent actor, document/workflow output, edit, delete, replay, and bad-record quarantine.
3. **Teamily incremental connector:** only after stable API access exists, add bounded poll or webhook support and pass the conformance suite.
4. **Evidence Bundle port:** define consumer identity, purpose, evidence list, and policy-filtered publication. Implement a local JSONL driver before any direct Teamily API driver.
5. **Proposal return path:** map agent-created suggestions to proposal-like pending objects; require a human or governed distill job to accept them.

## 5. Non-goals

- Reimplementing Teamily chat, studios, public feed, agent marketplace, model routing, or multi-agent orchestration.
- Treating an agent's memory or generated summary as authority without Event evidence and lifecycle controls.
- Building a source adapter before receiving a real schema and consent model.