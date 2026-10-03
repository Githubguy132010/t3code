import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as KiloRuntime from "./KiloRuntime.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it.live("rejects every local open before executing the binary or changing config", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-kilo-safety-" });
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    let spawned = 0;
    const observedSpawner = {
      ...spawner,
      spawn: (...args: Parameters<typeof spawner.spawn>) => {
        spawned++;
        return spawner.spawn(...args);
      },
    };
    const profile = path.join(root, "profile");
    const fixtures = [
      ".kilo/mcp.json",
      ".kilocode/mcp.json",
      "profile/config/kilo/kilo.json",
      ".kilo/kilo.json",
    ];
    const sources = new Map<string, string>();
    for (const [index, file] of fixtures.entries()) {
      const target = path.join(root, file);
      const command = [
        "node",
        "-e",
        `require('node:fs').writeFileSync(${encode(path.join(root, "marker"))}, 'executed')`,
      ];
      const contents = encode(
        file.endsWith("mcp.json")
          ? {
              mcpServers: {
                [`new-server-${index}`]: { command: command[0], args: command.slice(1) },
              },
            }
          : {
              mcp: { [`new-server-${index}`]: { type: "local", command } },
            },
      );
      yield* fs.makeDirectory(path.dirname(target), { recursive: true });
      yield* fs.writeFileString(target, contents);
      sources.set(target, contents);
    }
    const runtime = yield* KiloRuntime.make({
      instanceId: "safety-a",
      binaryPath: process.env.KILO_BIN ?? "kilo",
      profileDirectory: profile,
      environment: {
        PATH: process.env.PATH,
        KILO_PURE: "0",
        KILO_DISABLE_PROJECT_CONFIG: "0",
        KILO_PLATFORM: "vscode",
        KILOCODE_FEATURE: "daemon",
      },
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, observedSpawner));
    for (const directory of [root, path.join(root, "nested"), root]) {
      const failure = yield* runtime.open(directory).pipe(Effect.flip);
      assert.equal(failure.operation, "runtime-safety");
    }
    // A later new server name and account change cannot open a second entry path.
    yield* fs.writeFileString(
      path.join(root, ".kilocode/mcp.json"),
      '{"mcpServers":{"later-server":{"url":"http://127.0.0.1:9"}}}',
    );
    sources.delete(path.join(root, ".kilocode/mcp.json"));
    const failure = yield* runtime.open(root).pipe(Effect.flip);
    assert.equal(failure.operation, "runtime-safety");
    assert.equal(spawned, 0);
    assert.isFalse(yield* fs.exists(path.join(root, "marker")));
    for (const [target, contents] of sources)
      assert.equal(yield* fs.readFileString(target), contents);
    // Credential selection still works, without starting a native process.
    const authDir = path.join(profile, "data/kilo");
    yield* fs.makeDirectory(authDir, { recursive: true });
    yield* fs.writeFileString(
      path.join(authDir, "auth.json"),
      '{"kilo":{"type":"api","key":"synthetic-a"}}',
    );
    const first = yield* KiloRuntime.readAuth(profile, {});
    yield* fs.writeFileString(
      path.join(authDir, "auth.json"),
      '{"kilo":{"type":"api","key":"synthetic-b"}}',
    );
    assert.notEqual(first, yield* KiloRuntime.readAuth(profile, {}));
    assert.equal(yield* KiloRuntime.readAuth(profile, { KILO_AUTH_CONTENT: first }), first);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
