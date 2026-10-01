import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type {
  CloudTaskSnapshot,
  CloudTaskSpec,
  ProviderSendTurnInput,
  ProviderSessionStartInput,
} from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";

export class CloudTaskError extends Data.TaggedError("CloudTaskError")<{ readonly message: string }> {}

export interface CloudTaskAdapters {
  readonly preflight: (
    spec: CloudTaskSpec,
    budget: { readonly durationSeconds: 1200; readonly maxAttempts: 2; readonly maxExtraUsd: 0 },
  ) => Effect.Effect<readonly string[], CloudTaskError>;
  /** Must target an authorized remote workspace, never the host T3 server's filesystem. */
  readonly prepare: (spec: CloudTaskSpec, branch: string) => Effect.Effect<void, CloudTaskError>;
  readonly agent: (
    session: ProviderSessionStartInput,
    turn: ProviderSendTurnInput,
  ) => Effect.Effect<void, CloudTaskError>;
  readonly commit: () => Effect.Effect<string, CloudTaskError>;
  readonly push: (branch: string, sha: string) => Effect.Effect<string, CloudTaskError>;
  readonly ci: (
    sha: string,
  ) => Effect.Effect<
    {
      readonly sha: string;
      readonly checks: readonly { readonly name: string; readonly conclusion: string }[];
    },
    CloudTaskError
  >;
  /** Idempotent: reconcile and pause even when preparation had an uncertain outcome. */
  readonly cleanup: () => Effect.Effect<void, CloudTaskError>;
}

const unavailable = () => Effect.fail(new CloudTaskError({ message: "Cloud execution is not configured" }));
export const unavailableCloudTaskAdapters: CloudTaskAdapters = {
  preflight: () =>
    Effect.succeed([
      "An authorized remote T3 provider environment is not connected.",
      "Agent authentication has not been approved for that environment.",
      "Repository write access and a verified free compute allowance are not configured.",
    ]),
  prepare: unavailable,
  agent: unavailable,
  commit: unavailable,
  push: unavailable,
  ci: unavailable,
  cleanup: unavailable,
};

/** Internal adapters return trusted receipts; no client may inject a CI success or enable authentication. */
export const runCloudTask = Effect.fnUntraced(function* (
  spec: CloudTaskSpec,
  id: string,
  adapters: CloudTaskAdapters,
) {
  let state: CloudTaskSnapshot = {
    repository: spec.repository,
    branch: `t3-cloud/${id}`,
    stage: "blocked",
    attempt: 0,
    sha: null,
    blockers: [],
    cleanupConfirmed: false,
  };
  const blockers = yield* adapters
    .preflight(spec, { durationSeconds: 1200, maxAttempts: 2, maxExtraUsd: 0 })
    .pipe(
      Effect.timeout("15 seconds"),
      Effect.catch(() => Effect.succeed(["Cloud authorization could not be verified."])),
    );
  if (blockers.length) return { ...state, blockers: [...blockers] };
  let preparationAttempted = false;
  const cleanup = Effect.gen(function* () {
    if (!preparationAttempted) return;
    yield* adapters.cleanup().pipe(
      Effect.timeout("15 seconds"),
      Effect.retry({ times: 2 }),
      Effect.tap(() =>
        Effect.sync(() => {
          state = { ...state, cleanupConfirmed: true };
        }),
      ),
      Effect.catch(() =>
        Effect.sync(() => {
          state = { ...state, stage: "cleanup-failed" };
        }),
      ),
    );
  });
  yield* Effect.gen(function* () {
    state = { ...state, stage: "preparing" };
    preparationAttempted = true;
    yield* adapters.prepare(spec, state.branch);
    for (let attempt = 1; attempt <= 2; attempt++) {
      state = { ...state, stage: "agent", attempt };
      const threadId = ThreadId.make(id);
      yield* adapters.agent(
        { threadId, providerInstanceId: spec.providerInstanceId, runtimeMode: "approval-required" },
        {
          threadId,
          input:
            attempt === 1
              ? spec.instruction
              : "Fix the required CI checks for the last task commit. Keep the original task scope.",
        },
      );
      const sha = yield* adapters.commit();
      if (!/^[a-f0-9]{40}$/.test(sha))
        return yield* Effect.fail(new CloudTaskError({ message: "Invalid commit receipt" }));
      state = { ...state, stage: "pushing", sha };
      if ((yield* adapters.push(state.branch, sha)) !== sha)
        return yield* Effect.fail(new CloudTaskError({ message: "Push receipt mismatch" }));
      state = { ...state, stage: "ci" };
      const result = yield* adapters.ci(sha);
      if (result.sha !== sha) return yield* Effect.fail(new CloudTaskError({ message: "CI receipt mismatch" }));
      if (
        spec.requiredChecks.every((name) => {
          const matching = result.checks.filter((check) => check.name === name);
          return matching.length === 1 && matching[0]?.conclusion === "success";
        })
      ) {
        state = { ...state, stage: "succeeded" };
        return;
      }
    }
    state = { ...state, stage: "failed" };
  }).pipe(
    Effect.timeout("20 minutes"),
    Effect.catch(() =>
      Effect.sync(() => {
        state = { ...state, stage: "failed" };
      }),
    ),
    Effect.ensuring(cleanup),
  );
  return state;
});
