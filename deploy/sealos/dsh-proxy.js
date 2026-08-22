#!/usr/bin/env node
const http = require("node:http");
const net = require("node:net");

const listenPort = Number(process.env.DSH_PROXY_PORT || 3081);
const targetPort = Number(process.env.DSH_PORT || 3080);
const targetHost = process.env.DSH_LOOPBACK_HOST || "127.0.0.1";

const server = http.createServer((req, res) => {
  const upstream = http.request(
    {
      host: targetHost,
      port: targetPort,
      path: req.url,
      method: req.method,
      headers: req.headers,
    },
    (incoming) => {
      res.writeHead(incoming.statusCode ?? 502, incoming.headers);
      incoming.pipe(res);
    },
  );
  upstream.on("error", (error) => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "text/plain" });
    }
    res.end(`dsh proxy: ${error.message}`);
  });
  req.pipe(upstream);
});

server.on("upgrade", (req, socket, head) => {
  const dest = net.connect(targetPort, targetHost, () => {
    const header =
      `${req.method} ${req.url} HTTP/1.1\r\n` +
      Object.entries(req.headers)
        .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}`)
        .join("\r\n") +
      "\r\n\r\n";
    dest.write(header);
    if (head.length > 0) {
      dest.write(head);
    }
    dest.pipe(socket);
    socket.pipe(dest);
  });
  dest.on("error", () => socket.destroy());
  socket.on("error", () => dest.destroy());
});

server.listen(listenPort, "0.0.0.0", () => {
  process.stdout.write(`dsh proxy 0.0.0.0:${listenPort} -> ${targetHost}:${targetPort}\n`);
});
