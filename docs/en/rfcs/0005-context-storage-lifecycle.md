# RFC 0005 — Context storage & lifecycle

- **Status:** Accepted
- **中文:** [../../zh/rfcs/0005-context-storage-lifecycle.md](../../zh/rfcs/0005-context-storage-lifecycle.md)
- **Depends on:** RFC 0002 (context graph semantics), RFC 0001 (standards identity)
- **Related:** RFC 0006 (ACL), RFC 0007 (daily distillation)
- **Methodology:** Regenic Book ch. 6 (standards machine feed), ch. 9 (unified context ≠ store everything hot)

## 1. Problem

RFC 0002 defines the **logical** context graph (Entity / Claim / Snapshot).
At product scale, raw operational context (IM, tickets, CS, agent turns) can
grow without bound. If raw text lives in the hot graph store, private-deploy
cost and retrieval quality both collapse.

This RFC defines the **physical** layer under the graph: what is stored where,
how volume is controlled, and how distilled artifacts stay small while remaining
auditable.

## 2. Goals

1. Separate **bytes** (Blob), **thin events** (Event), **distilled products**
   (Digest), and **standards** (RFC 0001) into distinct durability classes.
2. Keep hot DB size roughly **O(digests + hot-window metadata + active standards)**,
   not O(all-time chat).
3. Guarantee **provenance**: any accepted Digest / StandardVersion can point at
   evidence Events; referenced blobs are GC-immune.
4. Remain private-deploy friendly: default stack is Postgres + object storage.

## 3. Non-goals

- Choosing a specific LLM or embedding vendor.
- Full IM product UX (shell may come later; this RFC is storage).
- Replacing RFC 0002 Claim/Snapshot semantics — Events **feed** Claims; they
  do not replace them.

## 4. Layer map

| Layer | Holds | Store | Lifetime |
| --- | --- | --- | --- |
| L0 Blob | Raw bytes (message body, attachment, transcript) | Object storage via `BlobStore` driver (MinIO / S3 / OSS, …) + zstd | Per GC policy |
| L1 Event | Thin operational atom + pointer | PostgreSQL (time-partitioned) | Long metadata; body via L0 |
| L2 Index | Hot-window search / optional vectors | pgvector or OpenSearch | Hot window only |
| L3 Digest | Thread / daily-direction distillates | PostgreSQL | Long; small |
| L4 Standard | RFC 0001 versions | PostgreSQL | Permanent |
| L5 Graph | Claim / Entity / Snapshot (RFC 0002) | PostgreSQL | Permanent / superseded chain |

Optional at extreme scale: ClickHouse (or Parquet in object storage) as an
**analytics replica** of Event rows — never the ACL authority.

## 5. Core types (physical)

### 5.1 `Blob`

| Field | Type | Notes |
| --- | --- | --- |
| `content_hash` | string | PK; sha256 of canonical bytes |
| `storage_uri` | string | Object key |
| `codec` | enum | `raw` \| `zstd` |
| `media_type` | string | |
| `byte_size` | int | Uncompressed |
| `stored_size` | int | On disk |
| `created_at` | datetime | |
| `ref_count` | int | Maintained or recomputed |

Identical content is stored once. Blobs have **no** standalone ACL; access is
always via an Event or Digest (`via_event_id` / `via_digest_id`).

Physical bytes are read/written only through a `BlobStore` port (put/get/delete/exists).
Drivers (MinIO, AWS S3, Aliyun OSS, …) are deployment config. `content_hash` is the
stable address; `storage_uri` may record driver-specific location for operations.

### 5.2 `Event`

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | Internal PK |
| `org_id` | string | |
| `source` | enum | `regenic` \| `feishu` \| `wecom` \| `slack` \| `ticket` \| `cs` \| … |
| `external_id` | string | Idempotency: unique `(org_id, source, external_id)` |
| `type` | enum | `message` \| `thread_reply` \| `ticket_update` \| `decision` \| `agent_turn` \| … |
| `channel_id` | string | |
| `thread_id` | string \| null | |
| `parent_event_id` | string \| null | |
| `actor_id` | string | Principal id (RFC 0006) |
| `actor_kind` | enum | `human` \| `agent` \| `system` |
| `ts` | datetime | Source time preferred |
| `ingested_at` | datetime | |
| `content_hash` | string | FK → Blob |
| `text_preview` | string \| null | ≤280 chars; same sensitivity as body |
| `acl_scope_id` | string | RFC 0006 |
| `direction_tags` | string[] | Optional coarse tags |
| `weight_hints` | object \| null | `{role_tier, evidence_class, source_trust}` |
| `attrs` | object | Source-specific; **no** long body |
| `tombstone` | boolean | Source recall / delete |
| `claim_id` | string \| null | Optional promotion link into RFC 0002 |

Indexes: `(org_id, ts DESC)`, `(org_id, channel_id, ts)`, `(content_hash)`.
Partition by `ts` (month/quarter).

### 5.3 `Digest`

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | |
| `org_id` | string | |
| `kind` | enum | `thread_summary` \| `daily_direction` \| … |
| `direction` | string | Controlled vocab (RFC 0007) |
| `period_start` / `period_end` | datetime | |
| `title` | string | |
| `body_hash` | string | FK → Blob (or short inline `body_text`) |
| `acl_scope_id` | string | |
| `required_scope_ids` | string[] | Derived from evidence; Job cannot widen |
| `score` | number | |
| `status` | enum | `proposed` \| `accepted` \| `rejected` \| `needs_clarify` \| `superseded` |
| `created_by` | string | Job or human principal |
| `supersedes_id` | string \| null | |

### 5.4 `DigestEvidence`

| Field | Type |
| --- | --- |
| `digest_id` | string |
| `event_id` | string |
| `weight_applied` | number |
| `reason` | string |
| `span` | object \| null | Optional offset into blob |

**Rule:** `accepted` Digests MUST have ≥1 evidence row.

### 5.5 Bridge to RFC 0002

Accepted Digests / high-signal Events MAY mint or update:

- `Claim` with `provenance.source_kind = system_import | agent_observation`
- `Provenance.source_ref = event_id` or `digest_id`
- `ContextSnapshot` for decisions still pins **claim ids**, not raw event floods

Agents and humans reason primarily on **Standards + Snapshots + Digests**,
pulling Events on demand.

## 6. Capacity-reduction structures

1. **Content-addressed dedupe** — one Blob per hash.
2. **Body out of Postgres** — thin Event rows only.
3. **Hierarchical distill** — Event → thread Digest → daily Digest → Standard.
4. **Vectors on distillates** (and optional hot-window subset), not all-time chat.
5. **Reference-keeplive GC** — see §7.

## 7. GC rules

### 7.1 Hard keeplive

Blob/Event metadata MUST NOT be hard-deleted if referenced by:

1. Any non-deleted `DigestEvidence`
2. Any `StandardVersion` source link
3. Any RFC 0003 Decision / Proposal evidence ref
4. Configured high-tier retention (e.g. CEO decision-class within window)
5. Compliance hold / break-glass access (RFC 0006)

### 7.2 Default lifetimes (org-configurable)

| Object | Default |
| --- | --- |
| Unreferenced Event body | Searchable 30d; cold 90d; deletable 180d |
| Event thin row | ≥180d then archive partition |
| Thread Digest | 1y or until absorbed + superseded |
| Accepted Daily Digest that fed a Standard | Longer / permanent pointer |
| StandardVersion | Permanent |
| Vector rows | Follow object lifetime |

### 7.3 Job order

```
recount refs → candidate expired∧unreferenced∧no hold
→ drop vectors → delete blob → archive/drop event partition
→ write gc_audit
```

### 7.4 Guardrail metrics

- `hot_pg_bytes` / org
- `blob_bytes_unreferenced`
- `digest_accept_rate`
- `events_with_digest_coverage`

Rising storage + flat coverage ⇒ distillation not working; do not only scale disks.

## 8. Acceptance criteria

1. Ingest 1M Events without storing bodies in Postgres.
2. Delete unreferenced blobs after policy window without breaking accepted Digest provenance.
3. Snapshot/decision path never requires loading full-channel history by default.

## 9. Decisions (#4 — approved)

- [x] **UTC storage, org-local Digest days.** Event `ts` stored/partitioned in
  UTC; daily Digest windows use org timezone config.
- [x] **`text_preview` survives body GC** for at least the thin Event row
  retention window (audit dust); same sensitivity as body — never widens ACL.
- [x] **Partition by `ts`, always scope by `org_id`.** Time-partition on `ts`
  with composite indexes including `org_id`; optional `org_id` hash
  subpartition only at extreme scale.
