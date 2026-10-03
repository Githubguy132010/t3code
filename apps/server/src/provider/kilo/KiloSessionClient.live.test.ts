// @effect-diagnostics globalTimers:off - bounds a native process startup; assertions wait on events, never sleeps.
// @effect-diagnostics nodeBuiltinImport:off - exercises the real SDK over Node HTTP and native CLI processes.
/** KILO_BIN=/path/to/kilo vp test run <this file>. No model or cloud task is run. */
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeEvents from "node:events";
import * as NodeHttp from "node:http";
import { createKiloClient } from "@kilocode/sdk/v2";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import * as KiloSessionClient from "./KiloSessionClient.ts";

const binary = process.env.KILO_BIN;
const run = Effect.runPromise;

describe.runIf(binary !== undefined)("Kilo 7.8.3 native local sessions", () => {
  let root: string;
  let url: string;
  let platform: string;
  let child: NodeChildProcess.ChildProcess | undefined;
  let exited: Promise<unknown> | undefined;
  let inferenceRequests = 0;
  const inference = NodeHttp.createServer((_req, res) => {
    inferenceRequests++;
    res.writeHead(500);
    res.end();
  });

  beforeAll(async () => {
    platform = await run(HostProcessPlatform);
    root = await NodeFSP.mkdtemp(
      NodePath.join(process.env.KILO_TEST_ROOT ?? NodeOS.tmpdir(), "t3-kilo-"),
    );
    await Promise.all(
      ["a", "b", "config", "data", "cache", "state"].map((p) =>
        NodeFSP.mkdir(NodePath.join(root, p)),
      ),
    );
    inference.listen(0, "127.0.0.1");
    await NodeEvents.EventEmitter.once(inference, "listening");
    const address = inference.address();
    if (address === null || typeof address === "string")
      throw new Error("No inference fixture listener");
    child = NodeChildProcess.spawn(binary!, ["serve", "--hostname=127.0.0.1", "--port=0"], {
      cwd: root,
      detached: platform !== "win32",
      env: {
        PATH: process.env.PATH,
        HTTP_PROXY: process.env.HTTP_PROXY,
        HTTPS_PROXY: process.env.HTTPS_PROXY,
        NO_PROXY: process.env.NO_PROXY,
        NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
        SSL_CERT_FILE: process.env.SSL_CERT_FILE,
        XDG_CONFIG_HOME: NodePath.join(root, "config"),
        XDG_DATA_HOME: NodePath.join(root, "data"),
        XDG_CACHE_HOME: NodePath.join(root, "cache"),
        XDG_STATE_HOME: NodePath.join(root, "state"),
        KILO_SERVER_PASSWORD: "local-test-only",
        KILO_DISABLE_AUTOUPDATE: "1",
        KILO_DISABLE_MODELS_FETCH: "1",
        KILO_DISABLE_DEFAULT_PLUGINS: "1",
        KILO_DISABLE_EXTERNAL_SKILLS: "1",
        KILO_DISABLE_PROJECT_CONFIG: "1",
        KILO_CONFIG_CONTENT: JSON.stringify({
          plugin: [],
          provider: {
            fixture: {
              npm: "@ai-sdk/openai-compatible",
              name: "Offline fixture",
              options: { baseURL: `http://127.0.0.1:${address.port}/v1` },
              models: { test: { name: "Offline", limit: { context: 10000, output: 1000 } } },
            },
          },
        }),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    exited = NodeEvents.EventEmitter.once(child, "exit");
    url = await new Promise<string>((resolve, reject) => {
      let output = "";
      const timeout = setTimeout(() => reject(new Error("Kilo startup timed out")), 25000);
      child!.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child!.on("exit", (code) => {
        clearTimeout(timeout);
        reject(new Error(`Kilo exited: ${code}`));
      });
      child!.stderr!.on("data", () => {});
      child!.stdout!.on("data", (chunk) => {
        output = (output + String(chunk)).slice(-65536);
        const match = /kilo server listening on (http:\/\/\S+)/.exec(output);
        if (match) {
          clearTimeout(timeout);
          resolve(match[1]!);
        }
      });
    });
  }, 30000);

  afterAll(async () => {
    if (child?.pid !== undefined && child.exitCode === null) {
      if (platform === "win32") child.kill("SIGKILL");
      else process.kill(-child.pid, "SIGKILL");
      await exited;
    }
    inference.closeAllConnections();
    await new Promise<void>((resolve) => inference.close(() => resolve()));
    if (root) await NodeFSP.rm(root, { recursive: true, force: true });
  });

  const connect = (name: "a" | "b") =>
    run(
      KiloSessionClient.make({
        instanceId: `instance-${name}`,
        directory: NodePath.join(root, name),
        baseUrl: url,
        serverPassword: "local-test-only",
      }),
    );

  it("creates concurrent native sessions, reads saved history, resumes and forks without inference", async () => {
    const [a, b] = await Promise.all([connect("a"), connect("b")]);
    const [ra, rb] = await Promise.all([run(a.create([])), run(b.create([]))]);
    expect(ra.sessionId).not.toBe(rb.sessionId);
    expect((await run(a.read(ra))).directory).toBe(NodePath.join(root, "a"));
    expect((await run(b.read(rb))).directory).toBe(NodePath.join(root, "b"));
    const native = createKiloClient({
      baseUrl: url,
      directory: NodePath.join(root, "a"),
      throwOnError: true,
      headers: { Authorization: `Basic ${Buffer.from("kilo:local-test-only").toString("base64")}` },
    });
    // noReply is implemented before the model loop in Kilo 7.8.3 SessionPrompt.prompt.
    // Synchronous admission creates real stored messages without any inference calls.
    const first = await native.session.prompt({
      sessionID: ra.sessionId,
      noReply: true,
      model: { providerID: "fixture", modelID: "test" },
      parts: [{ type: "text", text: "first" }],
    });
    const second = await native.session.prompt({
      sessionID: ra.sessionId,
      noReply: true,
      model: { providerID: "fixture", modelID: "test" },
      parts: [{ type: "text", text: "second" }],
    });
    const resumed = await connect("a");
    expect((await run(resumed.history(ra))).map((m) => m.info.id)).toEqual([
      first.data!.info.id,
      second.data!.info.id,
    ]);
    expect(await run(b.history(rb))).toEqual([]);
    const fork = await run(resumed.fork(ra, second.data!.info.id));
    expect(
      (await run(resumed.history(fork))).map((m) =>
        m.parts.filter((p) => p.type === "text").map((p) => p.text),
      ),
    ).toEqual([["first"]]);
    await run(resumed.revert(ra, second.data!.info.id));
    expect((await run(resumed.read(ra))).revert?.messageID).toBe(second.data!.info.id);
    await run(resumed.abort(ra));
    expect((await run(b.read(rb))).id).toBe(rb.sessionId);
    expect(inferenceRequests).toBe(0);
  }, 30000);

  it("streams actual native message events past sync envelopes without inference", async () => {
    const subscribed = Promise.withResolvers<void>();
    // Observe the upstream response to establish stream readiness without timer polling.
    const proxy = NodeHttp.createServer((req, res) => {
      const upstream = NodeHttp.request(
        new URL(req.url!, url),
        {
          method: req.method,
          headers: req.headers,
        },
        (response) => {
          res.writeHead(response.statusCode!, response.headers);
          response.pipe(res);
          if (req.url!.startsWith("/event")) subscribed.resolve();
        },
      );
      upstream.on("error", () => res.destroy());
      res.on("close", () => upstream.destroy());
      req.pipe(upstream);
    });
    proxy.listen(0, "127.0.0.1");
    await NodeEvents.EventEmitter.once(proxy, "listening");
    const address = proxy.address();
    if (address === null || typeof address === "string") throw new Error("No proxy listener");
    const controller = new AbortController();
    try {
      const directory = NodePath.join(root, "a");
      const client = await run(
        KiloSessionClient.make({
          instanceId: "native-stream",
          directory,
          baseUrl: `http://127.0.0.1:${address.port}`,
          serverPassword: "local-test-only",
        }),
      );
      const ref = await run(client.create([]));
      const received = run(
        client.events(ref).pipe(
          Stream.filter((event) => event.type === "message.part.updated"),
          Stream.take(1),
          Stream.runCollect,
          Effect.scoped,
        ),
        { signal: controller.signal },
      );
      // Always install a rejection handler before the independent native request.
      const settled = received.then(
        (events) => ({ events }),
        (error: unknown) => ({ error }),
      );
      await subscribed.promise;
      const native = createKiloClient({
        baseUrl: url,
        directory,
        throwOnError: true,
        headers: {
          Authorization: `Basic ${Buffer.from("kilo:local-test-only").toString("base64")}`,
        },
      });
      const message = await native.session.prompt({
        sessionID: ref.sessionId,
        noReply: true,
        model: { providerID: "fixture", modelID: "test" },
        parts: [{ type: "text", text: "native stream" }],
      });
      const result = await settled;
      if ("error" in result) throw result.error;
      expect(result.events).toHaveLength(1);
      const event = result.events[0]!;
      expect(event.type).toBe("message.part.updated");
      if (event.type === "message.part.updated") {
        expect(event.properties.part.sessionID).toBe(ref.sessionId);
        expect(event.properties.part.messageID).toBe(message.data!.info.id);
      }
      expect(inferenceRequests).toBe(0);
    } finally {
      controller.abort();
      proxy.closeAllConnections();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  }, 15000);

  it("rejects wrong auth and foreign native ids using the actual server", async () => {
    const error = await run(
      KiloSessionClient.make({
        instanceId: "bad",
        directory: root,
        baseUrl: url,
        serverPassword: "wrong",
      }).pipe(Effect.flip),
    );
    expect(error.reason).toBe("request_failed");
    const [a, b] = await Promise.all([connect("a"), connect("b")]);
    const foreign = await run(b.create([]));
    const forged = { ...foreign, instanceId: "instance-a", directory: NodePath.join(root, "a") };
    expect((await run(a.abort(forged).pipe(Effect.flip))).reason).toBe("wrong_owner");
    expect((await run(b.read(foreign))).id).toBe(foreign.sessionId);
  }, 15000);
});
