import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ProviderSession, ProviderRuntimeEvent, ProviderTurnStartResult } from "@t3tools/contracts";
import { PilotTurn, runPilotTurn, runPilotSetup, type PilotReceipt } from "./CloudPilotWorker.ts";
const decodeJob = Schema.decodeSync(PilotTurn);
const decodeSession = Schema.decodeSync(ProviderSession);
const decodeEvent = Schema.decodeSync(ProviderRuntimeEvent);
const decodeStarted = Schema.decodeSync(ProviderTurnStartResult);
const job = decodeJob({
  id: "a".repeat(32),
  attempt: 1,
  deadline: 9000000000000,
  runtimeMode: "approval-required",
  spec: {
    repository: "owner/repo",
    baseSha: "b".repeat(40),
    providerInstanceId: "codex",
    instruction: "Fix a test",
    requiredChecks: ["unit"],
  },
});

it.effect("setup reports authenticated readiness without starting an agent", () =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const receipts: PilotReceipt[] = [];
    const result = yield* runPilotSetup({ ...job, deadline: now + 480_000 }, Effect.succeed(true),
      (value) => Effect.sync(() => { receipts.push(value); }));
    expect(result.stage).toBe("setup-ready");
    expect(receipts.map((value) => value.stage)).toEqual(["setup-waiting", "setup-ready"]);
  }),
);

it.effect("expired setup never inspects or admits a provider", () =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    let inspected = false;
    const result = yield* runPilotSetup({ ...job, deadline: now - 1 },
      Effect.sync(() => { inspected = true; return true; }), () => Effect.void);
    expect(result.stage).toBe("failed");
    expect(inspected).toBe(false);
  }),
);

it.effect("awaits the real provider completion event and persists confirmed cleanup", () =>
  Effect.gen(function* () {
    const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const receipts: PilotReceipt[] = [];
    const provider = {
      streamEvents: Stream.fromPubSub(events),
      startSession: (threadId: ProviderSession["threadId"]) =>
        Effect.succeed(
          decodeSession({
            threadId,
            provider: "codex",
            status: "ready",
            runtimeMode: "approval-required",
            createdAt: "2026-10-01T00:00:00Z",
            updatedAt: "2026-10-01T00:00:00Z",
          }),
        ),
      sendTurn: (input: { threadId: ProviderSession["threadId"] }) =>
        Effect.gen(function* () {
          yield* PubSub.publish(
            events,
            decodeEvent({
              type: "turn.completed",
              eventId: "event-1",
              provider: "codex",
              threadId: input.threadId,
              createdAt: "2026-10-01T00:00:00Z",
              payload: { state: "completed" },
            }),
          );
          return decodeStarted({ threadId: input.threadId, turnId: "turn-1" });
        }),
      interruptTurn: () => Effect.void,
      stopSession: () => Effect.void,
    };
    const result = yield* runPilotTurn(job, provider, (value) =>
      Effect.sync(() => {
        receipts.push(value);
      }),
    );
    expect(result.stage).toBe("completed");
    expect(receipts.at(-1)?.cleanupConfirmed).toBe(true);
    expect(receipts.map((r) => r.stage)).toEqual(["starting", "running", "completed"]);
  }),
);

it.effect("interruption leaves a queryable cleanup receipt", () =>
  Effect.gen(function* () {
    const admitted = yield* Deferred.make<void>();
    const receipts: PilotReceipt[] = [];
    const provider = {
      streamEvents: Stream.never,
      startSession: () => Effect.never,
      sendTurn: () => Effect.never,
      interruptTurn: () => Effect.void,
      stopSession: () => Effect.void,
    };
    const worker = yield* runPilotTurn(job, provider, (value) =>
      Effect.gen(function* () {
        receipts.push(value);
        yield* Deferred.succeed(admitted, undefined);
      }),
    ).pipe(Effect.forkChild);
    yield* Deferred.await(admitted);
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(worker);
    expect(receipts.at(-1)?.stage).toBe("interrupted");
  }),
);
