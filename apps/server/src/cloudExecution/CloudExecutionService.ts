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
    const session = new UpstashBoxSession();
    yield* Effect.addFinalizer(() => Effect.promise(() => session.dispose()).pipe(Effect.ignore));
    return CloudExecutionService.of({
      execute: (sessionId, command) =>
        Effect.tryPromise({
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
              if (command.action === "attach" && session.snapshot().phase === "unconfigured")
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
        }),
    });
  }),
);
