import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { ProviderInstanceId } from "@t3tools/contracts";
import {
  CloudTaskError,
  runCloudTask,
  unavailableCloudTaskAdapters,
  type CloudTaskAdapters,
} from "./CloudTaskRunner.ts";
const sha = "a".repeat(40);
const spec = {
  repository: "owner/repo",
  baseSha: sha,
  providerInstanceId: ProviderInstanceId.make("codex"),
  instruction: "Fix the test",
  requiredChecks: ["unit"],
};
function fixture() {
  const calls: string[] = [];
  const adapters: CloudTaskAdapters = {
    preflight: () => Effect.succeed([]),
    prepare: () =>
      Effect.sync(() => {
        calls.push("prepare");
      }),
    agent: (session) =>
      Effect.sync(() => {
        expect(session.runtimeMode).toBe("approval-required");
        calls.push("agent");
      }),
    commit: () => Effect.succeed(sha),
    push: (branch, head) =>
      Effect.sync(() => {
        expect(branch).toBe("t3-cloud/test");
        calls.push("push");
        return head;
      }),
    ci: (head) => Effect.succeed({ sha: head, checks: [{ name: "unit", conclusion: "success" }] }),
    cleanup: () =>
      Effect.sync(() => {
        calls.push("cleanup");
      }),
  };
  return { adapters, calls };
}
it.effect("fails closed without credentials or an approved remote environment", () =>
  Effect.gen(function* () {
    const result = yield* runCloudTask(spec, "test", unavailableCloudTaskAdapters);
    expect(result.stage).toBe("blocked");
    expect(result.attempt).toBe(0);
    expect(result.blockers).toHaveLength(3);
  }),
);
it.effect("requires CI success for the exact pushed SHA then confirms cleanup", () =>
  Effect.gen(function* () {
    const { adapters, calls } = fixture();
    const result = yield* runCloudTask(spec, "test", adapters);
    expect(result.stage).toBe("succeeded");
    expect(result.sha).toBe(sha);
    expect(result.cleanupConfirmed).toBe(true);
    expect(calls).toEqual(["prepare", "agent", "push", "cleanup"]);
  }),
);
it.effect("rejects stale CI success and cleans up without another agent attempt", () =>
  Effect.gen(function* () {
    const { adapters, calls } = fixture();
    const result = yield* runCloudTask(spec, "test", {
      ...adapters,
      ci: () =>
        Effect.succeed({ sha: "b".repeat(40), checks: [{ name: "unit", conclusion: "success" }] }),
    });
    expect(result.stage).toBe("failed");
    expect(result.attempt).toBe(1);
    expect(calls.filter((x) => x === "agent")).toHaveLength(1);
    expect(calls.at(-1)).toBe("cleanup");
  }),
);
it.effect("limits failed or absent required checks to two attempts", () =>
  Effect.gen(function* () {
    const { adapters, calls } = fixture();
    const result = yield* runCloudTask(spec, "test", {
      ...adapters,
      ci: () => Effect.succeed({ sha, checks: [] }),
    });
    expect(result.stage).toBe("failed");
    expect(result.attempt).toBe(2);
    expect(calls.filter((x) => x === "agent")).toHaveLength(2);
    expect(result.cleanupConfirmed).toBe(true);
  }),
);
it.effect("cleans up uncertain preparation and exposes exhausted cleanup retries", () =>
  Effect.gen(function* () {
    const { adapters } = fixture();
    let attempts = 0;
    const result = yield* runCloudTask(spec, "test", {
      ...adapters,
      prepare: () => Effect.fail(new CloudTaskError({ message: "Unconfirmed" })),
      cleanup: () =>
        Effect.gen(function* () {
          attempts++;
          return yield* Effect.fail(new CloudTaskError({ message: "Unconfirmed" }));
        }),
    });
    expect(attempts).toBe(3);
    expect(result.stage).toBe("cleanup-failed");
    expect(result.cleanupConfirmed).toBe(false);
  }),
);
it.effect("interrupting an active task still confirms cleanup", () =>
  Effect.gen(function* () {
    const { adapters, calls } = fixture();
    const worker = yield* Effect.forkChild(
      runCloudTask(spec, "test", { ...adapters, agent: () => Effect.never }),
    );
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(worker);
    expect(calls.at(-1)).toBe("cleanup");
  }),
);

it.effect("rejects ambiguous duplicate CI receipts", () =>
  Effect.gen(function* () {
    const { adapters } = fixture();
    const result = yield* runCloudTask(spec, "test", {
      ...adapters,
      ci: () =>
        Effect.succeed({
          sha,
          checks: [
            { name: "unit", conclusion: "failure" },
            { name: "unit", conclusion: "success" },
          ],
        }),
    });
    expect(result.stage).toBe("failed");
    expect(result.attempt).toBe(2);
  }),
);
it.effect("rejects a push receipt for another SHA before querying CI", () =>
  Effect.gen(function* () {
    const { adapters } = fixture();
    let queried = false;
    const result = yield* runCloudTask(spec, "test", {
      ...adapters,
      preflight: (_, budget) =>
        Effect.sync(() => {
          expect(budget).toEqual({ durationSeconds: 1200, maxAttempts: 2, maxExtraUsd: 0 });
          return [];
        }),
      push: () => Effect.succeed("b".repeat(40)),
      ci: () =>
        Effect.sync(() => {
          queried = true;
          return { sha, checks: [] };
        }),
    });
    expect(result.stage).toBe("failed");
    expect(result.attempt).toBe(1);
    expect(queried).toBe(false);
    expect(result.cleanupConfirmed).toBe(true);
  }),
);
