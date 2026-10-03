import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { signalProcessGroup } from "../../process/processGroup.ts";
import * as KiloSessionClient from "./KiloSessionClient.ts";

export class KiloRuntimeError extends Schema.TaggedError<KiloRuntimeError>()("KiloRuntimeError", {
  operation: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return this.detail;
  }
}

export interface KiloConnection {
  readonly client: Effect.Success<ReturnType<typeof KiloSessionClient.make>>;
  readonly stop: Effect.Effect<void>;
  readonly cleanup: Effect.Effect<void>;
  readonly exitCode: Effect.Effect<number>;
  readonly isRunning: Effect.Effect<boolean>;
}

export class KiloRuntime extends Context.Service<
  KiloRuntime,
  {
    readonly open: (
      directory: string,
    ) => Effect.Effect<KiloConnection, KiloRuntimeError, Scope.Scope>;
  }
>()("t3/provider/kilo/KiloRuntime") {}

/** Every open owns a process. Registry replacement closes the old account's process scopes. */
export const make = Effect.fn("KiloRuntime.make")(function* (input: {
  readonly instanceId: string;
  readonly binaryPath: string;
  /** An XDG root for this account, not the Kilo data directory itself. */
  readonly profileDirectory: string;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const platform = yield* HostProcessPlatform;
  const owner = yield* Effect.scope;
  const fail = (operation: string, detail: string) => (cause: unknown) =>
    new KiloRuntimeError({ operation, detail, cause });
  const profile = path.resolve(input.profileDirectory);
  const environment: NodeJS.ProcessEnv = {
    ...input.environment,
    XDG_CONFIG_HOME: path.join(profile, "config"),
    XDG_DATA_HOME: path.join(profile, "data"),
    XDG_CACHE_HOME: path.join(profile, "cache"),
    XDG_STATE_HOME: path.join(profile, "state"),
    KILO_DISABLE_AUTOUPDATE: "1",
    // Background children outlive root turns and need a separate T3 continuation contract.
    KILO_EXPERIMENTAL_BACKGROUND_SUBAGENTS: "false",
    KILO_SERVER_USERNAME: "kilo",
  };
  let closed = false;
  yield* Scope.addFinalizer(
    owner,
    Effect.sync(() => {
      closed = true;
    }),
  );
  // Readiness output can contain project/plugin diagnostics; never include it in client errors.
  return KiloRuntime.of({
    open: Effect.fn("KiloRuntime.open")(function* (directory) {
      if (closed)
        return yield* new KiloRuntimeError({
          operation: "open",
          detail: "Kilo account runtime has been retired.",
        });
      const caller = yield* Effect.scope;
      const scope = yield* Scope.fork(owner);
      yield* Scope.addFinalizer(caller, Scope.close(scope, Exit.void));
      const start = Effect.gen(function* () {
        for (const name of ["config", "data", "cache", "state"]) {
          yield* fs
            .makeDirectory(path.join(profile, name), { recursive: true })
            .pipe(Effect.mapError(fail("profile", "Could not prepare the Kilo account profile.")));
        }
        const password = Encoding.encodeBase64Url(
          yield* crypto
            .randomBytes(32)
            .pipe(Effect.mapError(fail("password", "Could not secure the local Kilo server."))),
        );
        const command = yield* resolveSpawnCommand(
          input.binaryPath,
          ["serve", "--hostname=127.0.0.1", "--port=0"],
          { env: environment, extendEnv: false },
        );
        const child = yield* spawner
          .spawn(
            ChildProcess.make(command.command, command.args, {
              cwd: directory,
              env: { ...environment, KILO_SERVER_PASSWORD: password },
              extendEnv: false,
              detached: platform !== "win32",
              shell: command.shell,
            }),
          )
          .pipe(Effect.mapError(fail("spawn", "Could not start Kilo. Check the binary path.")));
        // Only this captured process group is signalled. No process-name matching.
        const cleanup = yield* Effect.cached(
          Effect.uninterruptible(
            platform === "win32"
              ? child
                  .kill({ killSignal: "SIGTERM", forceKillAfter: "1 second" })
                  .pipe(Effect.ignore)
              : Effect.sync(() => {
                  try {
                    signalProcessGroup(Number(child.pid), "SIGTERM");
                  } catch {
                    /* already exited */
                  }
                }).pipe(
                  Effect.andThen(
                    child.exitCode.pipe(Effect.timeoutOption("1 second"), Effect.ignore),
                  ),
                  Effect.andThen(
                    Effect.sync(() => {
                      try {
                        signalProcessGroup(Number(child.pid), "SIGKILL");
                      } catch {
                        /* already exited */
                      }
                    }),
                  ),
                ),
          ),
        );
        yield* Effect.addFinalizer(() => cleanup);
        const ready = yield* Deferred.make<string, KiloRuntimeError>();
        let output = "";
        yield* child.stdout.pipe(
          Stream.decodeText(),
          Stream.runForEach((chunk) => {
            output = (output + chunk).slice(-65536);
            const match = /kilo server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
            return match ? Deferred.succeed(ready, match[1]!).pipe(Effect.asVoid) : Effect.void;
          }),
          Effect.ignore,
          Effect.forkIn(scope),
        );
        yield* child.stderr.pipe(Stream.runDrain, Effect.ignore, Effect.forkIn(scope));
        const exitCode = child.exitCode.pipe(
          Effect.map(Number),
          Effect.orElseSucceed(() => -1),
        );
        yield* exitCode.pipe(
          Effect.flatMap((code) =>
            Deferred.fail(
              ready,
              new KiloRuntimeError({
                operation: "startup",
                detail: `Kilo exited during startup (code ${code}).`,
              }),
            ),
          ),
          Effect.forkIn(scope),
        );
        const url = yield* Deferred.await(ready).pipe(
          Effect.timeout("30 seconds"),
          Effect.mapError(
            fail("startup", "Kilo did not become ready. Check its installation and configuration."),
          ),
        );
        const client = yield* KiloSessionClient.make({
          instanceId: input.instanceId,
          directory,
          baseUrl: url,
          serverPassword: password,
        }).pipe(
          Effect.mapError(
            fail(
              "health",
              "Kilo's authenticated health check failed. This provider requires version 7.8.3.",
            ),
          ),
        );
        if (!(yield* child.isRunning.pipe(Effect.orElseSucceed(() => false)))) {
          return yield* new KiloRuntimeError({
            operation: "startup",
            detail: "Kilo exited before readiness completed.",
          });
        }
        return {
          stop: Scope.close(scope, Exit.void),
          cleanup,
          client,
          exitCode,
          isRunning: child.isRunning.pipe(Effect.orElseSucceed(() => false)),
        } satisfies KiloConnection;
      });
      return yield* start.pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.onError(() => Scope.close(scope, Exit.void)),
      );
    }),
  });
});
