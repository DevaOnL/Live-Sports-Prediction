import { createServer } from "node:http";

const port = Number(process.env.WORKER_PORT ?? "4001");

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("WORKER_PORT must be an integer between 1 and 65535.");
}

const health = {
  service: "worker",
  status: "alive",
  scope: "process-only",
  jobsEnabled: false,
  databaseConnections: false,
} as const;

// The HTTP event loop keeps the health listener active.
const server = createServer((request, response) => {
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");

  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200);
    response.end(JSON.stringify(health));
    return;
  }

  response.writeHead(404);
  response.end(JSON.stringify({ error: "Not found" }));
});

server.listen(port, "0.0.0.0", () => {
  console.info(
    `Worker health server listening on port ${port}; job processing disabled.`,
  );
});

let shuttingDown = false;

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  server.close(() => {
    process.exitCode = 0;
  });

  setTimeout(() => process.exit(0), 5_000).unref();
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
