import { expect, it, vi, afterEach } from "vite-plus/test";
import * as Effect from "effect/Effect";
import { CloudExecutionService, layer } from "./CloudExecutionService.ts";
import { requiredScopeForRpcMethod } from "../auth/RpcAuthorization.ts";
import { AuthRelayWriteScope, WS_METHODS } from "@t3tools/contracts";
afterEach(() => vi.unstubAllGlobals());
it("requires relay-write authorization for cloud control", () => {
  expect(requiredScopeForRpcMethod(WS_METHODS.cloudExecutionCommand)).toBe(AuthRelayWriteScope);
});
it("isolates the in-memory key owner and returns only safe state", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ status: "paused" })),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* CloudExecutionService;
      const state = yield* service.execute("owner-a", {
        action: "attach",
        boxId: "selected-box",
        apiKey: "dummy-pilot-only",
      });
      expect(state.phase).toBe("ready");
      expect(JSON.stringify(state)).not.toContain("dummy-pilot-only");
      const denied = yield* Effect.result(service.execute("owner-b", { action: "pause" }));
      expect(denied._tag).toBe("Failure");
      expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(layer)),
  );
});

it("releases failed attachment ownership for another authorized session", async () => {
  let status = "running";
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ status })));
  await Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* CloudExecutionService;
      const failed = yield* Effect.result(service.execute("owner-a", {
        action: "attach", boxId: "selected-box", apiKey: "dummy-pilot-only",
      }));
      expect(failed._tag).toBe("Failure");
      status = "paused";
      const state = yield* service.execute("owner-b", {
        action: "attach", boxId: "selected-box", apiKey: "dummy-pilot-only",
      });
      expect(state.phase).toBe("ready");
    }).pipe(Effect.provide(layer)),
  );
});

it("does not release ownership when a duplicate attachment is rejected", async () => {
  let finish!: (response: Response) => void;
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; })));
  await Effect.runPromise(Effect.gen(function* () {
    const service = yield* CloudExecutionService;
    const attach = { action: "attach" as const, boxId: "selected-box", apiKey: "dummy-pilot-only" };
    const first = Effect.runPromise(service.execute("owner-a", attach));
    yield* Effect.promise(async () => { await Promise.resolve(); });
    const duplicate = yield* Effect.result(service.execute("owner-a", attach));
    expect(duplicate._tag).toBe("Failure");
    const stranger = yield* Effect.result(service.execute("owner-b", attach));
    expect(stranger._tag).toBe("Failure");
    finish(Response.json({ status: "paused" }));
    yield* Effect.promise(() => first);
    const takeover = yield* Effect.result(service.execute("owner-b", { action: "resume", confirmedFree: true, maxExtraUsd: 0, durationSeconds: 1800 }));
    expect(takeover._tag).toBe("Failure");
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  }).pipe(Effect.provide(layer)));
});
