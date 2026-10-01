import * as NodeCrypto from "node:crypto";
import { runCloudTask, unavailableCloudTaskAdapters } from "./CloudTaskRunner.ts";
import type { CloudTaskSnapshot } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  CloudExecutionError,
  type CloudExecutionCommand,
  type CloudExecutionSnapshot,
} from "@t3tools/contracts";
import { UpstashBoxSession } from "./UpstashBoxAdapter.ts";
export class CloudExecutionService extends Context.Service<
  CloudExecutionService,
  {
    readonly execute: (
      owner: string,
      command: CloudExecutionCommand,
    ) => Effect.Effect<CloudExecutionSnapshot, CloudExecutionError>;
  }
>()("t3/cloudExecution/CloudExecutionService") {}
export const layer = Layer.effect(
  CloudExecutionService,
  Effect.gen(function* () {
    let owner: string | undefined;
    let attaching = false;
    let task: CloudTaskSnapshot | undefined;
    let taskBusy = false;
    const session = new UpstashBoxSession();
    yield* Effect.addFinalizer(() => Effect.promise(() => session.dispose()).pipe(Effect.ignore));
    return CloudExecutionService.of({
      execute: Effect.fnUntraced(function* (sessionId: string, command: CloudExecutionCommand) {
        if (owner !== undefined && owner !== sessionId)
          return yield* Effect.fail(new CloudExecutionError({ message: "Cloud session belongs to another client." }));
        if (command.action === "task-submit" || command.action === "task-status" || command.action === "task-clear") {
          if (taskBusy) return yield* Effect.fail(new CloudExecutionError({ message: "Task readiness check is already running." }));
          if (command.action === "task-submit") {
            owner = sessionId;
            taskBusy = true;
            task = yield* runCloudTask(command.spec, NodeCrypto.randomUUID(), unavailableCloudTaskAdapters).pipe(
              Effect.ensuring(Effect.sync(() => { taskBusy = false; })),
            );
          } else if (command.action === "task-clear") {
            task = undefined;
            if (!attaching && session.snapshot().phase === "unconfigured") owner = undefined;
          }
          return { ...session.snapshot(), ...(task ? { task } : {}) };
        }
        return yield* Effect.tryPromise({
          try: async () => {
            if (owner !== undefined && owner !== sessionId)
              return Promise.reject(new Error("Already owned"));
            if (owner === undefined && command.action !== "attach") {
              if (command.action === "status") return session.snapshot();
              throw new Error("Attach first");
            }
            if (command.action === "attach") {
              if (attaching || session.snapshot().phase !== "unconfigured")
                throw new Error("Attachment unavailable");
              attaching = true;
              owner = sessionId;
            }
            try {
              return await session.execute(command);
            } catch (error) {
              if (command.action === "attach" && session.snapshot().phase === "unconfigured" && !task)
                owner = undefined;
              throw error;
            } finally {
              if (command.action === "attach") attaching = false;
            }
          },
          catch: () =>
            new CloudExecutionError({
              message: "Cloud action failed or is unconfirmed. Check the selected Box in Upstash.",
            }),
        });
      }),
    });
  }),
);
