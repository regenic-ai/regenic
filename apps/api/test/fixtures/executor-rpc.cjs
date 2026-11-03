const { createServer } = require("node:http");
const { randomUUID } = require("node:crypto");

const runs = new Map();
let sequence = 0;
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  response.setHeader("content-type", "application/json");
  if (request.url === "/start") {
    const handle = { external_run_id: `synthetic-${process.pid}-${++sequence}-${randomUUID()}`, status: "waiting" };
    runs.set(handle.external_run_id, { ...handle, owner: body.owner });
    response.end(JSON.stringify(handle));
    return;
  }
  const run = runs.get(body.run?.external_run_id);
  if (!run || run.owner !== body.owner) {
    response.writeHead(409);
    response.end(JSON.stringify({ error: "ownership mismatch" }));
    return;
  }
  if (request.url === "/resume") run.status = "running";
  if (request.url === "/cancel") run.status = "cancelled";
  response.end(JSON.stringify({ external_run_id: run.external_run_id, status: run.status }));
});
server.listen(0, "127.0.0.1", () => {
  process.send({ port: server.address().port });
});
process.on("message", (message) => {
  if (message === "stop") {
    server.closeAllConnections();
    server.close(() => process.exit(0));
  }
});
process.on("disconnect", () => {
  server.closeAllConnections();
  server.close(() => process.exit(0));
});
