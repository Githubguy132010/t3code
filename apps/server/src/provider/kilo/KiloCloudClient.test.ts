// @effect-diagnostics nodeBuiltinImport:off - exercises the customer HTTP contract over a real loopback socket.
import * as NodeHttp from "node:http";
import * as NodeEvents from "node:events";
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Cloud from "./KiloCloudClient.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const sessionId = "agent_12345678-1234-1234-1234-123456789abc";
const messageId = "msg_0123456789ab0123456789ABCD";
const ref: Cloud.KiloCloudRef = { accountKey: "account-a", sessionId, messageId };
const start = {
  messageId,
  prompt: "Contract fixture only",
  repository: { type: "github" as const, repo: "fixture/project" },
  model: "fixture/model",
  mode: "code",
};
const run = Effect.runPromise;
async function client(
  handler: (request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) => void,
) {
  const server = NodeHttp.createServer(handler);
  server.listen(0, "127.0.0.1");
  await NodeEvents.EventEmitter.once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return Cloud.make({
    accountKey: ref.accountKey,
    apiKey: Redacted.make("fixture-customer-token"),
    origin: `http://127.0.0.1:${address.port}`,
  });
}
function json(response: NodeHttp.ServerResponse, data: unknown) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ result: { data } }));
}
describe("Kilo customer Cloud Agent boundary", () => {
  it("sends one bearer-authenticated admission and validates its caller-persisted message ID", async () => {
    const requests: unknown[] = [];
    const cloud = await client((request, response) => {
      expect(request.headers.authorization).toBe("Bearer fixture-customer-token");
      expect(request.url).toBe("/trpc/start");
      let body = "";
      request.on("data", (chunk) => {
        body += String(chunk);
      });
      request.on("end", () => {
        requests.push(JSON.parse(body));
        json(response, {
          cloudAgentSessionId: sessionId,
          kiloSessionId: "ses_remote",
          messageId,
          delivery: "queued",
        });
      });
    });
    expect(await run(cloud.start(start))).toEqual(ref);
    expect(requests).toEqual([
      {
        message: { id: messageId, prompt: start.prompt },
        repository: start.repository,
        agent: { model: start.model, mode: start.mode },
        options: { createdOnPlatform: "kilo-cli" },
      },
    ]);
  });
  it("does not retry or declare stopped after a response is lost following admission", async () => {
    let accepted = 0;
    const cloud = await client((request, response) => {
      request.resume();
      request.on("end", () => {
        accepted++;
        response.destroy();
      });
    });
    const failure = await run(cloud.start(start).pipe(Effect.flip));
    expect(failure.reason).toBe("admission_unknown");
    expect(failure.messageId).toBe(messageId);
    expect(accepted).toBe(1);
  });
  it.each([408, 409, 500, 503, 307])(
    "never follows or retries mutation status %i",
    async (status) => {
      let requests = 0;
      const cloud = await client((_request, response) => {
        requests++;
        response.writeHead(status, { location: "/other" });
        response.end();
      });
      expect((await run(cloud.start(start).pipe(Effect.flip))).reason).toBe("admission_unknown");
      expect(requests).toBe(1);
    },
  );
  it("rejects a mismatched session on send and a mismatched message on result", async () => {
    const cloud = await client((request, response) =>
      json(
        response,
        request.method === "POST"
          ? {
              cloudAgentSessionId: "agent_aaaaaaaa-1234-1234-1234-123456789abc",
              messageId,
              delivery: "started",
            }
          : {
              cloudAgentSessionId: sessionId,
              messageId: "msg_aaaaaaaaaaaa0123456789ABCD",
              status: "completed",
              createdAt: 1,
            },
      ),
    );
    expect((await run(cloud.send(ref, messageId, "test").pipe(Effect.flip))).reason).toBe(
      "admission_unknown",
    );
    expect((await run(cloud.result(ref).pipe(Effect.flip))).reason).toBe("wrong_owner");
  });
  it("cannot reuse another account's ref or issue an invented stop request", async () => {
    let requests = 0;
    const cloud = await client((_request, response) => {
      requests++;
      response.end();
    });
    expect(
      (await run(cloud.result({ ...ref, accountKey: "account-b" }).pipe(Effect.flip))).reason,
    ).toBe("wrong_owner");
    expect((await run(cloud.interrupt(ref).pipe(Effect.flip))).reason).toBe("unsupported");
    expect(requests).toBe(0);
  });
  it("keeps billing unknown even when a task has a confirmed terminal result", async () => {
    const cloud = await client((_request, response) =>
      json(response, {
        cloudAgentSessionId: sessionId,
        messageId,
        status: "interrupted",
        createdAt: 1,
        terminalAt: 2,
      }),
    );
    const result = await run(cloud.result(ref));
    expect(result.status).toBe("interrupted");
    expect(result.billingStatus).toBe("unknown");
  });
});
