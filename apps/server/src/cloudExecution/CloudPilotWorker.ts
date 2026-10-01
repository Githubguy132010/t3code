// Disposable PR #2 prototype. Only the explicitly enabled Box server reads this mailbox.
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { CloudTaskSpec, ThreadId } from "@t3tools/contracts";
import { ProviderService, type ProviderServiceShape } from "../provider/Services/ProviderService.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { CloudTaskError } from "./CloudTaskRunner.ts";

export const PilotTurn = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)),
  spec: CloudTaskSpec,
  attempt: Schema.Literals([1, 2]),
  deadline: Schema.Number,
  // Explicit activation approval selects this; never infer full-access mode.
  runtimeMode: Schema.Literals(["approval-required", "auto-accept-edits"]),
});
export type PilotTurn = typeof PilotTurn.Type;
export interface PilotReceipt {
  readonly id: string;
  readonly stage: "starting" | "running" | "completed" | "failed" | "approval-required" | "interrupted";
  readonly cleanupConfirmed: boolean;
}
type PilotProvider = Pick<ProviderServiceShape, "startSession" | "sendTurn" | "stopSession" | "interruptTurn" | "streamEvents">;

export const runPilotTurn = Effect.fnUntraced(function* (
  job: PilotTurn,
  provider: PilotProvider,
  save: (receipt: PilotReceipt) => Effect.Effect<void, CloudTaskError>,
) {
  const now = yield* Clock.currentTimeMillis;
  const threadId = ThreadId.make(`cloud-${job.id}-${job.attempt}`);
  let receipt: PilotReceipt = { id: job.id, stage: "starting", cleanupConfirmed: false };
  let started = false;
  const persist = () => save(receipt);
  yield* persist();
  yield* Effect.gen(function* () {
    const done = yield* Deferred.make<void, CloudTaskError>();
    // Start listening before session/turn admission, including synchronous provider failures.
    yield* provider.streamEvents.pipe(Stream.runForEach((event) => {
      if (event.threadId !== threadId) return Effect.void;
      if (event.type === "request.opened" || event.type === "user-input.requested") {
        receipt = { ...receipt, stage: "approval-required" };
        return Deferred.fail(done, new CloudTaskError({ message: "Interactive approval required" }));
      }
      if (event.type === "turn.completed") {
        return event.payload.state === "completed"
          ? Deferred.succeed(done, undefined)
          : Deferred.fail(done, new CloudTaskError({ message: "Provider turn did not complete" }));
      }
      if (event.type === "turn.aborted" || event.type === "runtime.error" || event.type === "session.exited")
        return Deferred.fail(done, new CloudTaskError({ message: "Provider stopped" }));
      return Effect.void;
    }), Effect.forkScoped);
    yield* Effect.yieldNow;
    started = true; // uncertain start still owns cleanup
    yield* provider.startSession(threadId, {
      threadId, providerInstanceId: job.spec.providerInstanceId,
      cwd: `/workspace/home/t3-pilot/jobs/${job.id}/repo`, runtimeMode: job.runtimeMode,
    });
    receipt = { ...receipt, stage: "running" };
    yield* persist();
    yield* provider.sendTurn({ threadId, input: job.spec.instruction });
    yield* Deferred.await(done);
    receipt = { ...receipt, stage: "completed" };
  }).pipe(
    Effect.timeout(Math.max(1, Math.min(600_000, job.deadline - now))),
    Effect.catch(() => Effect.sync(() => {
      if (receipt.stage !== "approval-required") receipt = { ...receipt, stage: "failed" };
    })),
    Effect.ensuring(Effect.gen(function* () {
      if (receipt.stage === "starting" || receipt.stage === "running") receipt = { ...receipt, stage: "interrupted" };
      if (started) {
        yield* provider.interruptTurn({ threadId }).pipe(Effect.timeout("5 seconds"), Effect.ignore);
        const stopped = yield* provider.stopSession({ threadId }).pipe(
          Effect.timeout("5 seconds"), Effect.retry({ times: 2 }),
          Effect.as(true), Effect.catch(() => Effect.succeed(false)),
        );
        receipt = { ...receipt, cleanupConfirmed: stopped };
      }
      yield* persist();
    })),
    Effect.scoped,
  );
  return receipt;
});

export const layer = Layer.effectDiscard(Effect.gen(function* () {
  const enabled = yield* Config.String("T3_CLOUD_PILOT_ENABLED").pipe(Config.withDefault(""));
  if (enabled !== "explicit-box-activation") return;
  const fs = yield* FileSystem.FileSystem;
  const provider = yield* ProviderService;
  const registry = yield* ProviderRegistry;
  const root = "/workspace/home/t3-pilot";
  const job = yield* fs.readFileString(`${root}/turn.json`).pipe(
    Effect.flatMap((text) => Schema.decodeEffect(Schema.fromJsonString(PilotTurn))(text)),
  );
  const jobDir = `${root}/jobs/${job.id}`;
  const receiptPath = `${jobDir}/turn-${job.attempt}.json`;
  // Never replay an admitted job after a restart or an uncertain disconnect.
  if (yield* fs.exists(receiptPath)) return;
  const save = (receipt: PilotReceipt) => Effect.gen(function* () {
    yield* fs.writeFileString(`${receiptPath}.tmp`, JSON.stringify(receipt));
    yield* fs.rename(`${receiptPath}.tmp`, receiptPath);
  }).pipe(Effect.mapError(() => new CloudTaskError({ message: "Could not persist pilot receipt" })));
  const snapshots = yield* registry.refreshInstance(job.spec.providerInstanceId);
  const selected = snapshots.find((item) => item.instanceId === job.spec.providerInstanceId);
  const now = yield* Clock.currentTimeMillis;
  if (job.deadline <= now || job.deadline > now + 1_200_000 ||
      selected?.driver !== "codex" || !selected.enabled || !selected.installed || selected.auth.status !== "authenticated") {
    yield* save({ id: job.id, stage: "failed", cleanupConfirmed: true });
    return;
  }
  yield* runPilotTurn(job, provider, save).pipe(Effect.forkScoped);
}));
