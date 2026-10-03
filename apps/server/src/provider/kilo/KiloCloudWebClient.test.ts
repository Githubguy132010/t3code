// @effect-diagnostics nodeBuiltinImport:off - exercises customer HTTP semantics over real sockets.
import * as NodeHttp from "node:http";
import * as NodeEvents from "node:events";
import { NodeWS } from "@effect/platform-node/NodeSocket";
import * as Stream from "effect/Stream";
import { afterEach, describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Redacted from "effect/Redacted";
import * as Cloud from "./KiloCloudWebClient.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
const binding: Cloud.CloudBinding = {
  accountId: "customer-a",
  cloudAgentSessionId: "workspace_12345678-1234-1234-1234-123456789abc",
  worktreeId: "worktree_12345678-1234-1234-1234-123456789abc",
  kiloSessionId: "ses_synthetic",
  repository: "fixture/project",
  branch: "main",
};
const messageId = "msg_0123456789ab0123456789ABCD";
const start = {
  operationKey: "12345678-1234-4234-9234-123456789abc",
  initialMessageId: messageId,
  prompt: "Read README only",
  repository: binding.repository,
  branch: "main",
  model: "fixture/model",
};
const session = {
  sessionId: binding.cloudAgentSessionId,
  kiloSessionId: binding.kiloSessionId,
  worktreeId: binding.worktreeId,
  userId: binding.accountId,
  githubRepo: binding.repository,
  upstreamBranch: "main",
  autoCommit: false,
  initialMessageId: messageId,
  execution: null,
};
const run = Effect.runPromise;
async function server(
  handler: (request: NodeHttp.IncomingMessage, response: NodeHttp.ServerResponse) => void,
  profiles: unknown = [],
  bindings: unknown = [],
) {
  const server = NodeHttp.createServer((request, response) => {
    if (request.url?.startsWith("/api/trpc/agentProfiles.listRepoBindings"))
      return json(response, bindings);
    if (request.url?.startsWith("/api/trpc/agentProfiles.list")) return json(response, profiles);
    handler(request, response);
  });
  server.listen(0, "127.0.0.1");
  await NodeEvents.EventEmitter.once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture address");
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const options = {
    accountId: binding.accountId,
    token: Redacted.make("fixture-token"),
    origin: `http://127.0.0.1:${address.port}`,
  };
  return { options, client: Cloud.make(options), httpServer: server };
}
function json(response: NodeHttp.ServerResponse, data: unknown) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ result: { data } }));
}
describe("Kilo personal Cloud control-plane customer API", () => {
  it("authenticates a customer WebSocket, resumes its cursor and rejects a foreign session event", async () => {
    const expiresAt = await run(Clock.currentTimeMillis);
    const { client, httpServer } = await server((req, res) => {
      expect(req.url).toBe("/api/cloud-agent-next/sessions/stream-ticket");
      expect(req.headers.authorization).toBe("Bearer fixture-token");
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ticket: "single-use-fixture", expiresAt: expiresAt + 60000 }));
      });
    });
    const sockets = new NodeWS.WebSocketServer({ noServer: true });
    cleanups.unshift(async () => {
      for (const socket of sockets.clients) socket.terminate();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
    });
    httpServer.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url!, "http://localhost");
      expect(url.searchParams.get("fromId")).toBe("37");
      expect(url.searchParams.get("ticket")).toBe("single-use-fixture");
      expect(url.searchParams.get("cloudAgentSessionId")).toBe(binding.cloudAgentSessionId);
      sockets.handleUpgrade(req, socket, head, (connection) => {
        connection.send(
          JSON.stringify({
            eventId: 38,
            sessionId: binding.cloudAgentSessionId,
            streamEventType: "cloud.message.completed",
            data: { messageId },
          }),
        );
        connection.send(
          JSON.stringify({
            eventId: 39,
            sessionId: "workspace_00000000-0000-0000-0000-000000000000",
            streamEventType: "cloud.message.failed",
            data: { messageId },
          }),
        );
      });
    });
    const received: number[] = [];
    const error = await run(
      client.events(binding, 37).pipe(
        Stream.tap((event) =>
          Effect.sync(() => {
            received.push(event.eventId);
          }),
        ),
        Stream.runDrain,
        Effect.flip,
      ),
    );
    expect(received).toEqual([38]);
    expect(error.operation).toBe("events");
  });
  it.each([
    "varCount",
    "commandCount",
    "mcpServerCount",
    "skillCount",
    "agentCount",
    "kiloCommandCount",
  ])("does not admit a paid task when an inherited profile has %s", async (counter) => {
    let mutations = 0;
    const profile = {
      id: "profile",
      isDefault: true,
      varCount: 0,
      commandCount: 0,
      mcpServerCount: 0,
      skillCount: 0,
      agentCount: 0,
      kiloCommandCount: 0,
      [counter]: 1,
    };
    const { client } = await server(
      (_request, response) => {
        mutations++;
        response.end();
      },
      [profile],
    );
    expect((await run(client.prepare(start).pipe(Effect.flip))).reason).toBe("rejected");
    expect(mutations).toBe(0);
  });
  it("fails closed when the repository binding references an unavailable profile", async () => {
    let mutations = 0;
    const { client } = await server(
      (_request, response) => {
        mutations++;
        response.end();
      },
      [],
      [{ repoFullName: "FIXTURE/PROJECT", platform: "github", profileId: "unavailable" }],
    );
    expect((await run(client.prepare(start).pipe(Effect.flip))).reason).toBe("rejected");
    expect(mutations).toBe(0);
  });
  it("uses customer authentication and fixed admission identities, no commits, setup or local data", async () => {
    const bodies: Record<string, unknown>[] = [];
    const { client } = await server((req, res) => {
      expect(req.headers.authorization).toBe("Bearer fixture-token");
      expect(req.url).toBe("/api/trpc/cloudAgentNext.prepareSession");
      let body = "";
      req.on("data", (chunk) => {
        body += String(chunk);
      });
      req.on("end", () => {
        bodies.push(JSON.parse(body));
        json(res, {
          cloudAgentSessionId: binding.cloudAgentSessionId,
          kiloSessionId: binding.kiloSessionId,
        });
      });
    });
    await run(client.prepare(start));
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      operationKey: start.operationKey,
      initialMessageId: messageId,
      githubRepo: binding.repository,
      upstreamBranch: "main",
      autoCommit: false,
      autoInitiate: true,
      envVars: {},
      setupCommands: [],
      mcpServers: {},
      runtimeSkills: [],
      runtimeAgents: [],
      mode: "code",
    });
    expect(bodies[0]).not.toHaveProperty("attachments");
  });
  it("leaves acceptance uncertain and never retries a socket lost after paid admission", async () => {
    let accepted = 0;
    const { client } = await server((req, res) => {
      req.resume();
      req.on("end", () => {
        accepted++;
        res.destroy();
      });
    });
    const error = await run(client.prepare(start).pipe(Effect.flip));
    expect(error.reason).toBe("admission_unknown");
    expect(error.messageId).toBe(messageId);
    expect(accepted).toBe(1);
  });
  it.each(["userId", "githubRepo", "kiloSessionId", "worktreeId", "autoCommit"])(
    "prevents a follow-up on changed %s",
    async (field) => {
      let sends = 0;
      const changed = {
        ...session,
        [field]:
          field === "autoCommit"
            ? true
            : field === "worktreeId"
              ? "worktree_aaaaaaaa-1234-1234-1234-123456789abc"
              : field === "kiloSessionId"
                ? "ses_other"
                : "other",
      };
      const { client } = await server((req, res) => {
        if (req.method === "POST") sends++;
        json(res, changed);
      });
      expect(
        (
          await run(
            client
              .send(binding, { messageId, prompt: "Continue", model: "fixture/model" })
              .pipe(Effect.flip),
          )
        ).reason,
      ).toBe("wrong_owner");
      expect(sends).toBe(0);
    },
  );
  it("rejects an account switch before any HTTP request, while allowing same-account token refresh", async () => {
    let requests = 0;
    const { options } = await server((req, res) => {
      requests++;
      expect(req.headers.authorization).toBe("Bearer refreshed");
      json(res, session);
    });
    const refreshed = Cloud.make({
      ...options,
      credentials: Effect.succeed({
        accountId: binding.accountId,
        token: Redacted.make("refreshed"),
      }),
    });
    await run(refreshed.getSession(binding.cloudAgentSessionId));
    const changed = Cloud.make({
      ...options,
      credentials: Effect.succeed({ accountId: "customer-b", token: Redacted.make("other") }),
    });
    expect(
      (await run(changed.getSession(binding.cloudAgentSessionId).pipe(Effect.flip))).reason,
    ).toBe("wrong_owner");
    expect(requests).toBe(1);
  });
  it("rejects a transcript with a part from another session", async () => {
    const { client } = await server((_req, res) =>
      json(res, {
        kiloSessionId: binding.kiloSessionId,
        watermarkEventId: 84,
        history: {
          nextCursor: null,
          omittedItemCount: 0,
          messages: [
            {
              info: {
                id: "assistant",
                sessionID: binding.kiloSessionId,
                role: "assistant",
                parentID: messageId,
                time: { created: 1, completed: 2 },
              },
              parts: [
                {
                  id: "part",
                  messageID: "assistant",
                  sessionID: "ses_other",
                  type: "text",
                  text: "Not this account",
                },
              ],
            },
          ],
        },
      }),
    );
    expect((await run(client.history(binding).pipe(Effect.flip))).reason).toBe("wrong_owner");
  });
  it("keeps interruption acceptance, task terminality, sandbox sleep and shared-payer billing separate", async () => {
    const { client } = await server((req, res) => {
      if (req.url?.includes("getSession?")) json(res, session);
      else if (req.url?.includes("interruptSession")) json(res, { success: true });
      else if (req.url?.includes("getMessageResult")) {
        const input = JSON.parse(new URL(req.url, "http://localhost").searchParams.get("input")!);
        expect(input.expectedWorktreeId).toBe(binding.worktreeId);
        json(res, {
          cloudAgentSessionId: binding.cloudAgentSessionId,
          messageId,
          status: "interrupted",
        });
      } else if (req.url?.includes("getSandboxStatus"))
        json(res, {
          status: "active",
          observedAt: 1,
          inactivityTimeoutMs: 600000,
          estimatedSleepAt: null,
        });
      else
        json(res, {
          phase: "active",
          attribution: "payer_shared",
          estimatedHourlyRateMicrodollars: 1203120,
          estimatedIntervalAmountMicrodollars: null,
        });
    });
    expect(await run(client.interrupt(binding))).toEqual({ success: true });
    expect((await run(client.result(binding, messageId)))?.status).toBe("interrupted");
    expect((await run(client.sandbox(binding))).status).toBe("active");
    expect((await run(client.billing(binding))).phase).toBe("active");
  });
});
