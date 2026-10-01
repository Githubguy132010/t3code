import * as Schema from "effect/Schema";
import { ProviderInstanceId } from "./providerInstance.ts";

export const CloudTaskSpec = Schema.Struct({
  repository: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/), Schema.isMaxLength(200)),
  baseSha: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/)),
  providerInstanceId: ProviderInstanceId,
  instruction: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(8000)),
  requiredChecks: Schema.Array(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100))).check(Schema.isMinLength(1), Schema.isMaxLength(10)),
});
export type CloudTaskSpec = typeof CloudTaskSpec.Type;
export const CloudTaskSnapshot = Schema.Struct({
  repository: Schema.String,
  branch: Schema.String,
  stage: Schema.Literals(["blocked", "preparing", "agent", "pushing", "ci", "succeeded", "failed", "cleanup-failed"]),
  attempt: Schema.Number,
  sha: Schema.NullOr(Schema.String),
  blockers: Schema.Array(Schema.String),
  cleanupConfirmed: Schema.Boolean,
});
export type CloudTaskSnapshot = typeof CloudTaskSnapshot.Type;
