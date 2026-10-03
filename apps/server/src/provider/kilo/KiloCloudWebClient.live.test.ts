import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { describe } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Account from "./KiloCloudAccount.ts";
import * as Cloud from "./KiloCloudWebClient.ts";

// Read-only opt-in. This never prepares a sandbox, submits a prompt or answers a request.
const profile = process.env.KILO_CLOUD_TEST_PROFILE;
const sessionId = process.env.KILO_CLOUD_READ_SESSION;
describe.skipIf(!profile || !sessionId)("Kilo Cloud customer read contract", () => {
  it.live(
    "reads native history and independent sandbox/billing evidence with official CLI login",
    () =>
      Effect.gen(function* () {
        const account = yield* Account.make(profile!);
        const credentials = yield* account.load;
        const client = Cloud.make({ ...credentials, credentials: account.load });
        const session = yield* client.getSession(sessionId!);
        const binding: Cloud.CloudBinding = {
          accountId: credentials.accountId,
          cloudAgentSessionId: session.sessionId,
          kiloSessionId: session.kiloSessionId,
          worktreeId: session.worktreeId,
          repository: session.githubRepo,
          branch: session.upstreamBranch ?? "main",
        };
        const page = yield* client.history(binding);
        assert.equal(page.kiloSessionId, session.kiloSessionId);
        assert.isTrue(
          page.history?.messages.some(
            (message) =>
              message.info.role === "assistant" &&
              message.parts.some((part) => part.type === "text" && !!part.text),
          ) ?? false,
        );
        const sandbox = yield* client.sandbox(binding);
        const billing = yield* client.billing(binding);
        assert.isTrue(sandbox.observedAt > 0);
        assert.isTrue(["session", "payer_shared"].includes(billing.attribution));
      }).pipe(Effect.provide(NodeServices.layer)),
    30_000,
  );
});
