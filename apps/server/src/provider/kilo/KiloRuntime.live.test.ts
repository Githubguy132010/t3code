import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import { describe } from "vite-plus/test";

import * as KiloRuntime from "./KiloRuntime.ts";
import { KiloDriver } from "../Drivers/KiloDriver.ts";
import * as ServerConfig from "../../config.ts";
import * as IdAllocator from "../../orchestration-v2/IdAllocator.ts";

const binary = process.env.KILO_BIN;
const environment = {
  PATH: process.env.PATH,
  HTTP_PROXY: process.env.HTTP_PROXY,
  HTTPS_PROXY: process.env.HTTPS_PROXY,
  NO_PROXY: process.env.NO_PROXY,
  NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
  KILO_DISABLE_MODELS_FETCH: "1",
  KILO_DISABLE_DEFAULT_PLUGINS: "1",
  KILO_DISABLE_EXTERNAL_SKILLS: "1",
  KILO_DISABLE_PROJECT_CONFIG: "1",
};

describe.runIf(binary !== undefined)("KiloRuntime native lifecycle", () => {
  it.live(
    "retires live clients and rejects saved threads after credentials change in the same profile",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kilo-account-change-" });
        const authDir = path.join(root, "data", "kilo");
        const authFile = path.join(authDir, "auth.json");
        yield* fs.makeDirectory(authDir, { recursive: true });
        const credentials = (key: string) => JSON.stringify({ kilo: { type: "api", key } });
        yield* fs.writeFileString(authFile, credentials("synthetic-account-a"));
        const runtime = yield* KiloRuntime.make({
          instanceId: "account-test",
          binaryPath: binary!,
          profileDirectory: root,
          environment,
        });
        const connection = yield* runtime.open(root);
        const native = yield* connection.client.create([]);
        const create = KiloDriver.create({
          instanceId: ProviderInstanceId.make("account-test"),
          displayName: undefined,
          enabled: false,
          config: { ...KiloDriver.defaultConfig(), binaryPath: binary!, profileDirectory: root },
          environment: Object.entries(environment).flatMap(([name, value]) =>
            value === undefined ? [] : [{ name, value, sensitive: false }],
          ),
        });
        const verify = Effect.gen(function* () {
          const first = yield* create;
          const request = {
            threadId: ThreadId.make("account-test"),
            providerSessionId: ProviderSessionId.make("account-test"),
            modelSelection: { instanceId: first.instanceId, model: "fixture/test" },
            runtimePolicy: {
              runtimeMode: "full-access" as const,
              interactionMode: "default" as const,
              cwd: root,
            },
          };
          const firstSession = yield* first.orchestrationAdapter.openSession(request);
          const thread = yield* firstSession.ensureThread(request);
          const unchanged = yield* create;
          assert.deepStrictEqual(unchanged.continuationIdentity, first.continuationIdentity);
          const resumed = yield* unchanged.orchestrationAdapter.openSession(request);
          assert.equal(
            (yield* resumed.resumeThread({ providerThread: thread })).nativeThreadRef?.nativeId,
            thread.nativeThreadRef?.nativeId,
          );
          yield* fs.writeFileString(authFile, credentials("synthetic-account-b"));
          const failure = yield* connection.client.read(native).pipe(Effect.flip);
          assert.equal(failure.reason, "wrong_owner");
          yield* connection.exitCode.pipe(Effect.timeout("5 seconds"));
          assert.isFalse(yield* connection.isRunning);
          yield* runtime.open(root).pipe(Effect.flip);
          const replacement = yield* create;
          assert.notEqual(
            replacement.continuationIdentity.continuationKey,
            first.continuationIdentity.continuationKey,
          );
          const secondSession = yield* replacement.orchestrationAdapter.openSession(request);
          const rejected = yield* secondSession
            .resumeThread({ providerThread: thread })
            .pipe(Effect.flip);
          assert.include(rejected.message, "account or configuration changed");
          const fresh = yield* secondSession.ensureThread(request);
          assert.notEqual(fresh.nativeThreadRef?.nativeId, thread.nativeThreadRef?.nativeId);
        });
        yield* verify.pipe(
          Effect.provide(
            Layer.mergeAll(
              ServerConfig.layerTest(root, { prefix: "t3-kilo-driver-" }),
              IdAllocator.layer,
            ),
          ),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    { timeout: 60000 },
  );

  it.live("rejects malformed credentials without exposing them or falling back to disk", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kilo-auth-" });
      for (const content of ["", "secret-not-json", "null", "[]"]) {
        const failure = yield* KiloRuntime.readAuth(root, { KILO_AUTH_CONTENT: content }).pipe(
          Effect.flip,
        );
        assert.equal(failure.operation, "authentication");
        assert.notInclude(failure.message, "secret-not-json");
        assert.isUndefined(failure.cause);
      }
      assert.equal(yield* KiloRuntime.readAuth(root, {}), "{}");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live(
    "isolates profiles, closes owned processes and resumes after restart",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kilo-runtime-" });
        const cwd = path.join(root, "work");
        yield* fs.makeDirectory(cwd);
        const accountScope = yield* Scope.fork(yield* Effect.scope);
        const runtime = yield* KiloRuntime.make({
          instanceId: "personal",
          binaryPath: binary!,
          profileDirectory: path.join(root, "personal"),
          environment,
        }).pipe(Effect.provideService(Scope.Scope, accountScope));
        const work = yield* KiloRuntime.make({
          instanceId: "work",
          binaryPath: binary!,
          profileDirectory: path.join(root, "work-account"),
          environment,
        });
        const sessionScope = yield* Scope.fork(yield* Effect.scope);
        const first = yield* runtime
          .open(cwd)
          .pipe(Effect.provideService(Scope.Scope, sessionScope));
        const other = yield* work.open(cwd);
        const ref = yield* first.client.create([]);
        const foreign = { ...ref, instanceId: "work" };
        yield* other.client.read(foreign).pipe(Effect.flip);
        const otherRef = yield* other.client.create([]);
        yield* Scope.close(sessionScope, Exit.void);
        assert.isFalse(yield* first.isRunning);
        assert.isTrue(yield* other.isRunning);
        const resumed = yield* runtime.open(cwd);
        assert.equal((yield* resumed.client.read(ref)).id, ref.sessionId);
        yield* Scope.close(accountScope, Exit.void);
        assert.isFalse(yield* resumed.isRunning);
        const retired = yield* runtime.open(cwd).pipe(Effect.flip);
        assert.equal(retired.operation, "open");
        assert.isTrue(yield* other.isRunning);
        assert.equal((yield* other.client.read(otherRef)).id, otherRef.sessionId);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    { timeout: 30000 },
  );

  it.live(
    "cleans failed startup and can open a fresh process afterward",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kilo-startup-" });
        const bad = yield* KiloRuntime.make({
          instanceId: "broken",
          binaryPath: path.join(root, "missing"),
          profileDirectory: root,
          environment,
        });
        const failure = yield* bad.open(root).pipe(Effect.flip);
        assert.equal(failure.operation, "spawn");
        const earlyExit = path.join(root, "early-exit");
        yield* fs.writeFileString(
          earlyExit,
          "#!/bin/sh\necho do-not-leak-this-diagnostic >&2\nexit 7\n",
        );
        yield* fs.chmod(earlyExit, 0o700);
        const exiting = yield* KiloRuntime.make({
          instanceId: "early",
          binaryPath: earlyExit,
          profileDirectory: root,
          environment,
        });
        const earlyFailure = yield* exiting.open(root).pipe(Effect.flip);
        assert.equal(earlyFailure.operation, "startup");
        assert.notInclude(earlyFailure.message, "do-not-leak");
        const good = yield* KiloRuntime.make({
          instanceId: "working",
          binaryPath: binary!,
          profileDirectory: root,
          environment,
        });
        const connection = yield* good.open(root);
        assert.isTrue(yield* connection.isRunning);
        yield* connection.client.create([]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    { timeout: 30000 },
  );
});
