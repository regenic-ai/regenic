const assert = require("node:assert/strict");
const { test } = require("node:test");
const { HttpCustomerBusinessGateway } = require("../dist/customer-business-gateway");

const query = {
  task_id: "task-1",
  brief_version: 1,
  customer_id: "customer-1",
  project_id: "project-1",
  batch_id: "batch-1",
  members: [{ member_key: "member-1", business_id: "business-1" }],
  fields: ["invitation_response"],
  query_at: "2026-10-22T04:00:00.000Z",
};

test("business gateway rejects a streamed response over the byte limit", async () => {
  const chunk = new Uint8Array(1024 * 1024);
  const gateway = new HttpCustomerBusinessGateway({
    url: "http://127.0.0.1/business",
    fetch: async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    })),
  });

  await assert.rejects(
    gateway.query(query),
    (error) => error.code === "business_unavailable"
      && error.message === "Business query response is too large",
  );
});

test("business gateway timeout remains active while reading the response body", async () => {
  const gateway = new HttpCustomerBusinessGateway({
    url: "http://127.0.0.1/business",
    timeout_ms: 100,
    fetch: async (_url, init) => new Response(new ReadableStream({
      start(controller) {
        init.signal.addEventListener("abort", () => {
          controller.error(new DOMException("aborted", "AbortError"));
        }, { once: true });
      },
    })),
  });

  await assert.rejects(
    gateway.query(query),
    (error) => error.code === "business_unavailable"
      && error.message === "Business query timed out",
  );
});
