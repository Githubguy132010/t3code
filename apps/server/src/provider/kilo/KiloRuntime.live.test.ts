import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import { describe } from "vite-plus/test";

import * as KiloRuntime from "./KiloRuntime.ts";

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
