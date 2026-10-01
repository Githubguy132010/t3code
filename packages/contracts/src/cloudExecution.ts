import { CloudTaskSpec, CloudTaskSnapshot } from "./cloudTask.ts";
import * as Schema from "effect/Schema";
export const CloudExecutionCommand = Schema.Union([
  Schema.Struct({ action: Schema.Literal("task-submit"), spec: CloudTaskSpec }),
  Schema.Struct({ action: Schema.Literals(["task-status", "task-clear"]) }),
  Schema.Struct({
    action: Schema.Literal("attach"),
    boxId: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,100}$/)),
    apiKey: Schema.String.check(Schema.isMinLength(8), Schema.isMaxLength(512)),
  }),
  Schema.Struct({
    action: Schema.Literal("resume"),
    confirmedFree: Schema.Literal(true),
    maxExtraUsd: Schema.Literal(0),
    durationSeconds: Schema.Literal(1800),
  }),
  Schema.Struct({ action: Schema.Literals(["status", "pause", "export"]) }),
]);
export type CloudExecutionCommand = typeof CloudExecutionCommand.Type;
export const CloudExecutionSnapshot = Schema.Struct({
  boxId: Schema.NullOr(Schema.String),
  phase: Schema.Literals([
    "unconfigured",
    "ready",
    "resuming",
    "running",
    "pausing",
    "cleanup-failed",
    "paused",
    "error",
  ]),
  deadline: Schema.NullOr(Schema.Number),
  pauseAttempts: Schema.Number,
  task: Schema.optionalKey(CloudTaskSnapshot),
  export: Schema.optionalKey(
    Schema.Struct({ patch: Schema.String, sha256: Schema.String, bytes: Schema.Number }),
  ),
});
export type CloudExecutionSnapshot = typeof CloudExecutionSnapshot.Type;
export class CloudExecutionError extends Schema.TaggedError<CloudExecutionError>()(
  "CloudExecutionError",
  { message: Schema.String },
) {}
