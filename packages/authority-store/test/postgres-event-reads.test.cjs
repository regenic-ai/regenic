const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  findBySourceIdentity,
  claimOutboundAttempt,
  getEvent,
  listEvents,
  openContextRead,
} = require("../dist/postgres/events");
const { listInbox } = require("../dist/postgres/inbox");

const metadataFields = ["direction_tags", "weight_hints", "attrs"];
const occurredAt = "2026-08-30T00:00:00.000Z";
const identity = { org_id: "org-1", source: "synthetic", external_id: "message-1" };

function eventRow(metadata, encoded) {
  const row = {
    ...identity,
    id: "event-1",
    operation: "create",
    content_hash: "a".repeat(64),
    parent_event_id: null,
    thread_id: "thread-1",
    actor_id: "person-1",
    required_scope_ids: ["scope-1"],
    direction_tags: null,
    weight_hints: null,
    attrs: null,
    occurred_at: new Date(occurredAt),
    ingested_at: new Date(occurredAt),
    ...metadata,
  };
  if (encoded) {
    for (const field of ["required_scope_ids", ...metadataFields]) {
      if (row[field] !== null) row[field] = JSON.stringify(row[field]);
    }
  }
  return row;
}

function projectMetadata(sql, row) {
  const columns = sql.slice(sql.indexOf("SELECT"), sql.indexOf("FROM"));
  const projected = { ...row };
  // Model explicit SELECT projection instead of returning unselected fixture fields.
  for (const field of metadataFields) {
    if (!new RegExp(`\\b${field}\\b`).test(columns)) delete projected[field];
  }
  return projected;
}

function assertMetadata(actual, expected) {
  for (const field of metadataFields) {
    assert.deepEqual(actual[field], expected[field], field);
  }
}

describe("postgres Event read projections without a live database", () => {
  const variants = [
    {
      name: "populated",
      metadata: {
        direction_tags: ["outbound", "follow_up"],
        weight_hints: { urgency: 0.8, importance: 0.6 },
        attrs: { entity_id: "entity-1", nested: { enabled: false, count: 0, value: null } },
      },
    },
    { name: "empty", metadata: { direction_tags: [], weight_hints: {}, attrs: {} } },
    { name: "absent", metadata: {} },
  ];

  for (const encoded of [false, true]) {
    for (const { name, metadata } of variants) {
      for (const surface of ["getEvent", "findBySourceIdentity", "listEvents", "listInbox"]) {
        it(`${surface} retains ${name} metadata from ${encoded ? "JSON text" : "native JSONB"}`, async () => {
          const row = eventRow(metadata, encoded);
          const db = {
            async query(sql) {
              return [projectMetadata(sql, {
                ...row,
                event_id: row.id,
                disposition_org_id: row.org_id,
                disposition: "current_work",
                layer: "L1_event",
                reason_codes: [],
                score: 1,
                decided_at: new Date(occurredAt),
              })];
            },
            async queryOne(sql) {
              return projectMetadata(sql, row);
            },
          };
          if (surface === "getEvent") {
            assertMetadata(await getEvent(db, identity.org_id, row.id), metadata);
          } else if (surface === "findBySourceIdentity") {
            assertMetadata(await findBySourceIdentity(db, identity), metadata);
          } else if (surface === "listEvents") {
            assertMetadata((await listEvents(db, identity.org_id))[0], metadata);
          } else {
            for (const query of [
              undefined, { heads: true }, { siblings: true }, { tasks: true },
              { list: "hidden" }, { list: "hidden", heads: true }, { list: "hidden", siblings: true },
            ]) {
              const [item] = await listInbox(db, identity.org_id, query);
              assertMetadata(item.event, metadata);
            }
          }
        });

        describe("postgres outbound retry claim SQL without a live database", () => {
          it("uses one conditional upsert guarded by thread and absence of delivery evidence", async () => {
            const input = {
              org_id: "org-1", client_request_id: "reply-1", thread_id: "feishu:oc_1",
              recovery_hash: "a".repeat(64), now: occurredAt,
            };
            for (const affected of [0, 1]) {
              const db = {
                async execute(sql, values) {
                  assert.match(sql, /ON CONFLICT\s*\(org_id, client_request_id\)\s*DO UPDATE/);
                  assert.match(sql, /WHERE outbound_attempts\.status = 'rejected'/);
                  assert.match(sql, /outbound_attempts\.thread_id = EXCLUDED\.thread_id/);
                  for (const field of ["event_id", "receipt_json", "channel_message_ids"]) {
                    assert.ok(sql.includes(`outbound_attempts.${field} IS NULL`), field);
                  }
                  assert.deepEqual(values, [
                    input.org_id, input.client_request_id, input.thread_id, input.recovery_hash, input.now,
                  ]);
                  return affected;
                },
              };
              assert.equal(await claimOutboundAttempt(db, input), affected === 1);
            }
          });
        });
      }
    }
  }

  it("keeps repeatable-read epochs independent of wall time and sensitive to lifecycle changes", async (context) => {
    context.mock.timers.enable({ apis: ["Date"], now: Date.parse(occurredAt) });
    let rows = [eventRow(variants[0].metadata, false)];
    const client = {};
    const db = {
      async query(sql, params, activeClient) {
        assert.equal(activeClient, client);
        if (sql.includes("FROM source_heads sh")) {
          return [{ source: identity.source, external_id: identity.external_id, head_event_id: rows.at(-1).id }];
        }
        return rows.map((row) => ({ ...row, content_media_type: "text/plain" }));
      },
      async withTx(fn, isolation) {
        assert.equal(isolation, "REPEATABLE READ");
        return fn(client);
      },
    };
    const first = await openContextRead(db, identity.org_id);
    context.mock.timers.tick(2_000);
    const repeated = await openContextRead(db, identity.org_id);
    assert.notEqual(repeated.recorded_at, first.recorded_at);
    assert.equal(repeated.read_epoch, first.read_epoch);
    rows = [...rows, {
      ...rows[0], id: "event-2", operation: "revise", parent_event_id: "event-1",
      content_hash: "b".repeat(64), occurred_at: new Date(), ingested_at: new Date(),
    }];
    assert.notEqual((await openContextRead(db, identity.org_id)).read_epoch, first.read_epoch);
  });
});
