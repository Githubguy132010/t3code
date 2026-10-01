import { expect, vi, afterEach } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import { CloudExecutionService, layer } from "./CloudExecutionService.ts";
import { requiredScopeForRpcMethod } from "../auth/RpcAuthorization.ts";
import { AuthRelayWriteScope, WS_METHODS } from "@t3tools/contracts";
afterEach(() => vi.unstubAllGlobals());
it("requires relay-write authorization for cloud control", () => {
  expect(requiredScopeForRpcMethod(WS_METHODS.cloudExecutionCommand)).toBe(AuthRelayWriteScope);
});
it.effect("isolates the in-memory key owner and returns only safe state", () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ status: "paused" })),
  );
  return Effect.gen(function* () {
    const service = yield* CloudExecutionService;
    const state = yield* service.execute("owner-a", {
      action: "attach",
      boxId: "selected-box",
      apiKey: "dummy-pilot-only",
    });
    expect(state.phase).toBe("ready");
    expect(state).toEqual({
      boxId: "selected-box",
      phase: "ready",
      deadline: null,
      pauseAttempts: 0,
    });
    const denied = yield* Effect.result(service.execute("owner-b", { action: "pause" }));
    expect(denied._tag).toBe("Failure");
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  }).pipe(Effect.provide(layer));
});

it.effect("releases failed attachment ownership for another authorized session", () => {
  let status = "running";
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ status })),
  );
  return Effect.gen(function* () {
    const service = yield* CloudExecutionService;
    const failed = yield* Effect.result(
      service.execute("owner-a", {
        action: "attach",
        boxId: "selected-box",
        apiKey: "dummy-pilot-only",
      }),
    );
    expect(failed._tag).toBe("Failure");
    status = "paused";
    const state = yield* service.execute("owner-b", {
      action: "attach",
      boxId: "selected-box",
      apiKey: "dummy-pilot-only",
    });
    expect(state.phase).toBe("ready");
  }).pipe(Effect.provide(layer));
});

it.effect("does not release ownership when a duplicate attachment is rejected", () => {
  let finish!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    ),
  );
  return Effect.gen(function* () {
    const service = yield* CloudExecutionService;
    const attach = { action: "attach" as const, boxId: "selected-box", apiKey: "dummy-pilot-only" };
    const first = yield* Effect.forkChild(service.execute("owner-a", attach));
    yield* Effect.yieldNow;
    const duplicate = yield* Effect.result(service.execute("owner-a", attach));
    expect(duplicate._tag).toBe("Failure");
    const stranger = yield* Effect.result(service.execute("owner-b", attach));
    expect(stranger._tag).toBe("Failure");
    finish(Response.json({ status: "paused" }));
    yield* Fiber.join(first);
    const takeover = yield* Effect.result(
      service.execute("owner-b", {
        action: "resume",
        confirmedFree: true,
        maxExtraUsd: 0,
        durationSeconds: 1800,
      }),
    );
    expect(takeover._tag).toBe("Failure");
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  }).pipe(Effect.provide(layer));
});
