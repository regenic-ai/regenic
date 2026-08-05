-- RFC 0007 D0 — rule-only daily distillation (sketch)
-- Not production migration SQL; illustrates selection, scoring, Top-N, ACL derive.
-- Assumes tables from RFC 0005 / 0006 exist.

-- Parameters (bind in job):
--   :org_id, :job_principal_id, :direction, :period_start, :period_end, :top_n (default 7)

CREATE TEMP TABLE IF NOT EXISTS d0_role_tier (
  principal_id uuid PRIMARY KEY,
  role_tier numeric NOT NULL
);

-- Populate from HR/title map or AclMembership attrs (org-specific).
-- Example seed omitted.

CREATE TEMP TABLE d0_candidates AS
SELECT
  e.id AS event_id,
  e.thread_id,
  e.channel_id,
  e.acl_scope_id,
  e.actor_id,
  e.text_preview,
  e.attrs,
  e.weight_hints,
  COALESCE((e.weight_hints->>'evidence_class'), 'opinion') AS evidence_class,
  COALESCE((e.weight_hints->>'source_trust')::numeric, 1.0) AS source_trust,
  COALESCE(rt.role_tier, 1.0) AS role_tier,
  CASE
    WHEN e.ts >= :period_start AND e.ts < :period_end THEN 1.0
    ELSE power(0.9, GREATEST(0, EXTRACT(DAY FROM (:period_end - e.ts))))
  END AS recency,
  CASE
    WHEN :direction = ANY (e.direction_tags) THEN 1.0
    ELSE 0.8
  END AS direction_fit
FROM events e
JOIN acl_memberships m
  ON m.scope_id = e.acl_scope_id
 AND m.principal_id = :job_principal_id
 AND m.role IN ('reader', 'writer', 'content_reader', 'acl_admin')
 AND (m.expires_at IS NULL OR m.expires_at > now())
LEFT JOIN d0_role_tier rt ON rt.principal_id = e.actor_id
WHERE e.org_id = :org_id
  AND e.tombstone IS NOT TRUE
  AND e.ts < :period_end
  AND e.ts >= :period_start - interval '3 days'  -- small backlog window
  AND (
    :direction = ANY (e.direction_tags)
    OR e.direction_tags IS NULL
    OR cardinality(e.direction_tags) = 0
  );

CREATE TEMP TABLE d0_scored AS
SELECT
  c.*,
  (c.role_tier
    * CASE c.evidence_class
        WHEN 'metric' THEN 4.0
        WHEN 'demo' THEN 3.0
        WHEN 'user_verbatim' THEN 2.5
        WHEN 'decision_record' THEN 2.5
        ELSE 1.0
      END
    * c.recency
    * c.source_trust
    * c.direction_fit
  ) AS base_score,
  CASE
    WHEN c.evidence_class = 'metric' THEN 'metric_signal'
    WHEN COALESCE(c.attrs->>'severity', '') IN ('high', 'critical') THEN 'bad_news'
    WHEN c.text_preview ~* '(事故|故障|违约|流失|lawsuit|outage|churn|breach)' THEN 'bad_news'
    WHEN c.role_tier >= 3.5 THEN 'hypothesis'
    ELSE NULL
  END AS item_kind
FROM d0_candidates c;

-- Drop chatter D0 will not emit
DELETE FROM d0_scored WHERE item_kind IS NULL;

-- Thread fold: keep highest base_score per thread (null thread => per event)
CREATE TEMP TABLE d0_folded AS
SELECT DISTINCT ON (COALESCE(thread_id::text, event_id::text))
  *
FROM d0_scored
ORDER BY COALESCE(thread_id::text, event_id::text), base_score DESC, event_id;

-- Authority split → clarify_request (same channel, opposite stance, both high tier)
CREATE TEMP TABLE d0_conflicts AS
SELECT
  a.event_id AS event_a,
  b.event_id AS event_b,
  a.channel_id
FROM d0_folded a
JOIN d0_folded b
  ON a.channel_id = b.channel_id
 AND a.event_id < b.event_id
 AND a.role_tier >= 3.5
 AND b.role_tier >= 3.5
 AND a.attrs ? 'stance'
 AND b.attrs ? 'stance'
 AND a.attrs->>'stance' <> b.attrs->>'stance';

-- Emit items: prefer conflicts as clarify_request, else ranked kinds
CREATE TEMP TABLE d0_items AS
SELECT
  gen_random_uuid() AS item_id,
  'clarify_request'::text AS item_kind,
  'Authority split requires clarify'::text AS title,
  NULL::uuid AS primary_event_id,
  ARRAY[c.event_a, c.event_b] AS evidence_event_ids,
  1000::numeric AS score  -- force into board; still subject to Top-N after bad_news seat
FROM d0_conflicts c
UNION ALL
SELECT
  gen_random_uuid(),
  f.item_kind,
  left(COALESCE(f.text_preview, f.item_kind), 120),
  f.event_id,
  ARRAY[f.event_id],
  f.base_score
FROM d0_folded f
WHERE NOT EXISTS (
  SELECT 1 FROM d0_conflicts c
  WHERE f.event_id IN (c.event_a, c.event_b)
);

-- Bad-news seat + Top-N
CREATE TEMP TABLE d0_emit AS
WITH ranked AS (
  SELECT
    i.*,
    CASE WHEN i.item_kind = 'bad_news' THEN 0 ELSE 1 END AS bn_group,
    row_number() OVER (
      PARTITION BY CASE WHEN i.item_kind = 'bad_news' THEN 0 ELSE 1 END
      ORDER BY i.score DESC
    ) AS rn_in_group,
    row_number() OVER (ORDER BY i.score DESC) AS rn_global
  FROM d0_items i
),
picked AS (
  -- at least one bad_news if exists
  SELECT * FROM ranked WHERE item_kind = 'bad_news' AND rn_in_group = 1
  UNION
  SELECT * FROM ranked
  WHERE item_kind <> 'bad_news'
  ORDER BY score DESC
  LIMIT GREATEST(:top_n - 1, 0)
)
SELECT * FROM picked
ORDER BY score DESC
LIMIT :top_n;

-- Derive required scopes from evidence
CREATE TEMP TABLE d0_item_scopes AS
SELECT
  e.item_id,
  array_agg(DISTINCT ev.acl_scope_id) AS required_scope_ids
FROM d0_emit e
JOIN LATERAL unnest(e.evidence_event_ids) AS eid(event_id) ON true
JOIN events ev ON ev.id = eid.event_id
GROUP BY e.item_id;

-- Idempotent write sketch: supersede prior proposed digest for same key
-- UPDATE digests SET status = 'superseded'
-- WHERE org_id = :org_id AND kind = 'daily_direction' AND direction = :direction
--   AND period_start = :period_start AND status = 'proposed';

-- INSERT digest + digest_items + digest_evidence …
-- (application code should assert job visible on every evidence id
--  and required_scope_ids == derive(evidence))

-- Coverage metric helper
-- SELECT count(DISTINCT event_id) FROM d0_candidates;  -- candidates
-- SELECT count(DISTINCT unnest(evidence_event_ids)) FROM d0_emit;  -- covered in emit
