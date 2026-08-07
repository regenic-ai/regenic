# Personal store → Org canonical

- **中文:** [../../zh/rfcs/personal-to-org.md](../../zh/rfcs/personal-to-org.md)
- **Status:** Draft product architecture (not a numbered RFC)
- **Depends on:** RFC 0005 (Event/Blob), 0002 (graph), 0006 (ACL), 0007 (distill)
- **Product:** [PRODUCT.md](../PRODUCT.md)

## 1. Problem

Personal Regenic holds a full processing loop for one principal. Org Regenic
must combine many personal streams without:

- treating every personal copy as a distinct fact (UNION explosion), or  
- promoting personal AI labels to org ground truth, or  
- escalating privilege via distill jobs.

## 2. Model

```text
Channel message (push or pull)
  → Personal Event (+ personal processing tags)
  → [explicit consent / work-scope policy]
  → Org Canonical Event (one physical fact)
       + Projections (per ingesting principal / view)
  → Org Digest / Claim / Snapshot (org job + visible())
```

| Concept | Role |
| --- | --- |
| Personal Event | Projection + subjective tags (priority, “should know”, unreplied) |
| Canonical Event | Objective fact: who / when / what / thread / tombstone |
| Projection | Who ingested it, what they were allowed to see, personal tags |
| Org Digest | Produced only by org pipeline (RFC 0007); never copies personal labels blindly |

## 3. Identity & dedupe

1. Prefer `(org_id, source, external_id)` as the cross-person join key.  
2. Else `(org_id, content_hash, ts_bucket, actor_canonical)`.  
3. Blobs stay content-addressed (`content_hash`); org stores/references once.  
4. Actors resolve via IdentityProvider map; unresolved → `unresolved`, no merge.

## 4. Objective vs subjective

| Class | Authority | Examples |
| --- | --- | --- |
| Objective | Canonical Event | Body hash, source timestamps, thread ids, tombstones |
| Subjective | Personal projection | Grade, should-know, unreplied rank, personal summary |

Org distill jobs may **read** subjective tags as hints; they MUST re-derive
org outputs under `visible(job)` and write org Digests / Claims with org
provenance.

## 5. Consent & scope

- Only work-bound connectors / channels aggregate by default.  
- Personal DMs stay out unless explicitly opted in.  
- Aggregation is per-connector or per-scope consent.  
- Org hot store prefers thin Events + hashes; bodies on demand + audit.

## 6. Conflicts

- Same hash → one canonical, multiple projections.  
- Edit / recall → version or `superseded` chain; do not clobber.  
- Unreplied state stays per-person unless the source system owns a shared
  status (e.g. ticket state).

## 7. Open source vs closed

| Surface | Intent |
| --- | --- |
| Personal runtime, local store, export, connectors (reference) | Open (this repo) |
| Multi-person aggregate, enterprise IdP wiring, compliance holds | Closed / commercial |

## 8. Acceptance (org overlay)

1. Two people ingest the same Feishu message → one canonical Event, two
   projections.  
2. Personal “should know” tags do not appear as org Claims without an org job.  
3. Turning off personal cloud history does not break org canonicalization for
   peers who still consent to aggregate.
