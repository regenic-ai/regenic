# RFC 0006 — ACL scopes & Agent identity

- **Status:** Accepted
- **中文:** [../../zh/rfcs/0006-acl-agent-identity.md](../../zh/rfcs/0006-acl-agent-identity.md)
- **Depends on:** RFC 0002 (`AccessPolicy`), RFC 0004 (API principals), RFC 0005 (Event/Digest attach points)
- **Related:** RFC 0007 (distillation must not escalate privilege)
- **Methodology:** Regenic Book ch. 9 — unified context ≠ transparent everything

## 1. Problem

RFC 0002 defines `AccessPolicy` on claims. Operational ingestion (channels,
tickets, agents) needs a concrete **membership** model, Agent binding rules,
and a single `visible()` used by list/search/vector/prompt assembly.

Without this, distillation and “shared context” silently become privilege
escalation.

## 2. Goals

1. Humans and Agents are both `Principal`s; Agents never get a shadow full-org view.
2. Authorization attaches to **AclScope**, not copied data.
3. Distillation cannot widen visibility (strict Digest rule).
4. One `visible(principal, resource)` for all read paths.
5. Grants, break-glass, and Agent bindings are auditable.

## 3. Non-goals

- Full IdP product (OIDC/SAML adapters come later).
- Per-message UX for sharing (v1 uses scopes + explicit share).
- Replacing RFC 0002 `AccessPolicy` — this RFC **implements** it for storage objects and maps to claim policies.

## 4. Identity

### 4.1 `Principal`

| Field | Type | Notes |
| --- | --- | --- |
| `id` | string | |
| `org_id` | string | |
| `kind` | enum | `human` \| `agent` \| `service` |
| `display_name` | string | |
| `status` | enum | `active` \| `disabled` |
| `external_refs` | object | Feishu/WeCom/Slack ids |

Mapping to RFC 0004 `ActorRef`: same `kind` + `id`.

### 4.2 `AgentBinding`

| Field | Type | Notes |
| --- | --- | --- |
| `agent_id` | string | Principal kind=agent |
| `mode` | enum | `as_user` \| `as_service` \| `dual` |
| `bound_human_id` | string \| null | Required for `as_user` |
| `service_scope_ids` | string[] | Required for `as_service` |
| `can_write_event` | bool | |
| `can_propose_digest` | bool | |
| `can_propose_standard` | bool | Default false |
| `max_evidence_class` | string \| null | Optional ceiling |

| Mode | Effective ACL |
| --- | --- |
| `as_user` | Intersection with bound human; audit `on_behalf_of` |
| `as_service` | Only `service_scope_ids` — **no** implicit org-admin |
| `dual` | Session token vs job token separated |

**Forbidden:** long-lived org-admin agent tokens for distillation.

## 5. AclScope

### 5.1 Kinds

| kind | Use |
| --- | --- |
| `org` | Org-public (still not unrestricted secrets) |
| `unit` | Department / BU |
| `project` | Mission unit |
| `channel` | IM / ticket room (align `Event.channel_id`) |
| `standard_ring` | Restricted standards circle |
| `ad_hoc` | M&A, HR cases |

### 5.2 Tables

**AclScope:** `id`, `org_id`, `kind`, `name`, `parent_id?`, `sensitivity`
(`public_in_org` \| `internal` \| `confidential` \| `restricted`), `attrs`.

**AclMembership:** `scope_id`, `principal_id`, `role`
(`reader` \| `writer` \| `acl_admin` \| `content_reader`),
`granted_by`, `granted_at`, `expires_at?`,
`source` (`manual` \| `hr_sync` \| `channel_mirror` \| `project_sync`).

Split `acl_admin` vs `content_reader` so HRBP-style admin need not read bodies.

### 5.3 Inheritance (conservative)

Unit trees do **not** auto-grant ancestors read on descendant channel content.
CEO/exec access is **explicit membership** or break-glass — not tree magic.

## 6. Resource attachment

| Resource | Field | Notes |
| --- | --- | --- |
| Event | `acl_scope_id` | Usually channel scope |
| Digest | `acl_scope_id` + `required_scope_ids` | See §8 |
| Standard | `acl_scope_id` | Read; activation separate |
| Blob | none | Access via `via_event_id` / `via_digest_id` only |
| Claim (0002) | `AccessPolicy` | Mapped from scopes at claim mint time |

## 7. `visible()` (normative)

```
visible(P, R) =
  active(P)
  ∧ ¬R.tombstone_hides_from(P)   -- tombstone still metadata-visible to admins
  ∧ (
      has_role(P, R.acl_scope_id, reader+)
      ∨ explicit_share(R, P)
      ∨ valid_break_glass(P, R)
    )
```

For Digests with `required_scope_ids = S1..Sn`:

```
visible(P, Digest) ⇔ ∀ Si ∈ required_scope_ids: has_role(P, Si, reader+)
```

**Search / vector / preview / prompt assembly MUST ACL-filter before ranking.**
Returning “hidden hit” metadata is a defect.

Blob download: authorize against the **via** resource, not bare hash.

## 8. Distillation & privilege

1. Jobs run as `service` principals with narrow `service_scope_ids`.
2. `required_scope_ids` are **derived** from evidence; writers cannot widen.
3. Optional Phase-2 **redacted Digest**: conclusion-only body, wider scope,
   no event ids / reversible quotes; creation audited.
4. Weight (RFC 0007) applies only inside the visible set — **weight ≠ ACL bypass**.

## 9. Writes

| Action | Requires |
| --- | --- |
| Write Event | scope `writer` + agent `can_write_event` if agent |
| Propose Digest | `can_propose_digest` + visible evidence |
| Accept Digest | human direction owner or scope admin |
| Activate StandardVersion | human (never agent alone) |
| Change membership | `acl_admin` |

## 10. External mirror

- Feishu/WeCom/Slack/ticket membership → `channel` scope membership.
- Leave channel ⇒ expire membership.
- Source “workspace admin sees all” does **not** map to Regenic org_admin unless
  customer explicitly enables mirror-admin privilege.
- Source recall ⇒ Event `tombstone`; ACL unchanged; body GC per RFC 0005.

## 11. Break-glass

Short TTL elevate with required reason, approver, forced security notify.
Any break-glass read extends GC keeplive on touched evidence.

## 12. Mapping to RFC 0002 `AccessPolicy`

| AccessPolicy.visibility | Typical scope materialization |
| --- | --- |
| `org` | `kind=org` membership |
| `team` | `unit` / `project` scopes |
| `decision_scoped` | Snapshot `built_for_principals` + claim policy |
| `restricted` | `ad_hoc` / `standard_ring` + deny_exfiltrate |

Claim mint from Event SHOULD copy effective sensitivity upward (never downward).

## 13. Acceptance criteria

1. Agent `as_user` cannot read channels the human cannot.
2. Daily Digest including a restricted evidence Event is invisible to principals
   missing that scope (unless redacted sibling exists).
3. Vector search with ACL filter disabled fails CI.

## 14. Decisions (#6 — approved)

- [x] **Customer-external principals allowed in CS channels** — channel-scope
  only (no org-wide membership).
- [x] **Multi-agent threads prefer per-agent `as_user`** over a shared service
  scope.
- [x] **Redacted Digests do not enter org-wide daily packs by default.**
