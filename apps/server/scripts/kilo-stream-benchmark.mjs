// node --expose-gc apps/server/scripts/kilo-stream-benchmark.mjs /absolute/baseline/KiloSessionClient.ts
// Extract the unchanged client with git show, beside a node_modules link to apps/server/node_modules.
// Baseline and current perform the same ownership read, filtering, validation and consumption.
// The raw SDK is diagnostic only: it does less work and is not a regression baseline.
import * as NodeHttp from "node:http";
import * as NodeEvents from "node:events";
import * as NodeURL from "node:url";
import * as NodeOS from "node:os";
import * as NodeAssert from "node:assert/strict";
import { createKiloClient } from "@kilocode/sdk/v2";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { make } from "../src/provider/kilo/KiloSessionClient.ts";

if (!process.argv[2] || !global.gc) throw new Error("Pass a baseline path and --expose-gc");
const baseline = await import(NodeURL.pathToFileURL(process.argv[2]).href);
const ref = { instanceId: "bench", directory: "/bench", sessionId: "ses_bench" };
let workload = { count: 10000, intervalMs: 0 };
const server = NodeHttp.createServer((req, res) => {
  if (!req.url.startsWith("/event")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify(
        req.url.startsWith("/global/health")
          ? { healthy: true, version: "7.8.3" }
          : { id: ref.sessionId, directory: ref.directory },
      ),
    );
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  const event = (i) =>
    `data: ${JSON.stringify({
      type: "message.part.delta",
      properties: {
        sessionID: i % 2 ? "ses_foreign" : ref.sessionId,
        messageID: "msg",
        partID: "part",
        field: "text",
        delta: JSON.stringify({ i, sentAt: performance.now() }),
      },
    })}\n\n`;
  if (!workload.intervalMs) {
    res.end(Array.from({ length: workload.count }, (_, i) => event(i)).join(""));
    return;
  }
  let index = 0;
  const timer = setInterval(() => {
    res.write(event(index++));
    if (index === workload.count) {
      clearInterval(timer);
      res.end();
    }
  }, workload.intervalMs);
  res.on("close", () => clearInterval(timer));
});
server.listen(0, "127.0.0.1");
await NodeEvents.once(server, "listening");
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const clients = {
  baseline: await Effect.runPromise(baseline.make({ ...ref, baseUrl })),
  current: await Effect.runPromise(make({ ...ref, baseUrl })),
};
const sdk = createKiloClient({ baseUrl, directory: ref.directory, throwOnError: true });
const results = [];
try {
  for (const scenario of ["burst", "paced"]) {
    workload =
      scenario === "burst" ? { count: 10000, intervalMs: 0 } : { count: 200, intervalMs: 5 };
    for (let round = 0; round < 8; round++) {
      const order = round % 2 ? ["current", "baseline", "sdk"] : ["sdk", "baseline", "current"];
      for (const kind of order) {
        global.gc();
        const heap = process.memoryUsage().heapUsed;
        const cpu = process.cpuUsage();
        const began = performance.now();
        const indices = [];
        const latency = [];
        const consume = (event) => {
          const delta = JSON.parse(event.properties.delta);
          indices.push(delta.i);
          latency.push(performance.now() - delta.sentAt);
        };
        if (kind === "sdk") {
          const subscription = await sdk.event.subscribe(undefined, { sseMaxRetryAttempts: 0 });
          for await (const event of subscription.stream)
            if (event.properties.sessionID === ref.sessionId) consume(event);
        } else {
          const failure = await Effect.runPromise(
            clients[kind].events(ref).pipe(
              Stream.runForEach((event) => Effect.sync(() => consume(event))),
              Effect.scoped,
              Effect.flip,
            ),
          );
          NodeAssert.equal(failure.reason, "request_failed"); // EOF is not task completion.
        }
        const wallMs = performance.now() - began;
        const used = process.cpuUsage(cpu);
        NodeAssert.deepEqual(
          indices,
          Array.from({ length: workload.count / 2 }, (_, i) => i * 2),
        );
        latency.sort((a, b) => a - b);
        results.push({
          scenario,
          round,
          kind,
          retained: indices.length,
          wallMs,
          cpuMs: (used.user + used.system) / 1000,
          heapDelta: process.memoryUsage().heapUsed - heap,
          latencyP50Ms: latency[Math.floor(latency.length * 0.5)],
          latencyP95Ms: latency[Math.floor(latency.length * 0.95)],
        });
      }
    }
  }
  console.log(
    JSON.stringify(
      {
        node: process.version,
        cpu: NodeOS.cpus()[0]?.model,
        baselinePath: process.argv[2],
        buffering: "HTTP/SSE to serial consumer; no added queue",
        results,
      },
      null,
      2,
    ),
  );
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
