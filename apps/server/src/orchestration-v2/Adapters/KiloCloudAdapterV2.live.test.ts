// @effect-diagnostics nodeBuiltinImport:off - opt-in live integration with loopback inference for local Kilo.
import * as NodeHttp from "node:http";
import * as NodeEvents from "node:events";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { describe } from "vite-plus/test";
import {
  OrchestrationV2ThreadProjection,
  RunId,
  RunAttemptId,
  NodeId,
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Account from "../../provider/kilo/KiloCloudAccount.ts";
import * as Cloud from "../../provider/kilo/KiloCloudWebClient.ts";
import * as Journal from "../../provider/kilo/KiloCloudJournal.ts";
import * as IdAllocator from "../IdAllocator.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as EffectWorker from "../EffectWorker.ts";
import * as Registry from "../ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../testkit/ProviderReplayHarness.ts";
import * as CloudAdapter from "./KiloCloudAdapterV2.ts";
import type * as Adapter from "../ProviderAdapter.ts";
import * as LocalAdapter from "./KiloAdapterV2.ts";
import * as LocalRuntime from "../../provider/kilo/KiloRuntime.ts";

// Explicit paid opt-in, never enabled by CI. A durable one-shot directory prevents
// an accidental rerun from admitting a duplicate sandbox after an uncertain result.
const profile = process.env.KILO_CLOUD_TEST_PROFILE;
const evidence = process.env.KILO_CLOUD_PAID_EVIDENCE;
const repository = process.env.KILO_CLOUD_TEST_REPOSITORY;
const enabled =
  process.env.KILO_CLOUD_ALLOW_PAID_TEST === "yes" &&
  process.env.KILO_CLOUD_ALLOW_FULL_ACCESS_READ_ONLY_TEST === "yes" &&
  process.env.KILO_BIN &&
  profile &&
  evidence &&
  repository;
const decodeProjection = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.toCodecJson(OrchestrationV2ThreadProjection)),
);
const json = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
describe.skipIf(!enabled)("paid Kilo Cloud integration", () => {
  it.live(
    "reads a synthetic repository and follows up through Orchestrator without local uploads",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(evidence!); // EEXIST deliberately prevents paid retries.
        const account = yield* Account.make(profile!);
        const credentials = yield* account.load;
        const client = Cloud.make({ ...credentials, credentials: account.load });
        const journal = yield* Journal.make(`${evidence}/journal`);
        const instanceId = ProviderInstanceId.make("kilo-cloud-paid-test");
        const threadId = ThreadId.make("kilo-cloud-paid-test");
        const modelSelection = {
          instanceId,
          model: "deepseek/deepseek-v4.1-flash",
          options: [{ id: "variant", value: "low" }],
        };
        const adapter = yield* CloudAdapter.make({
          instanceId,
          continuationKey: "kilo-cloud-paid-test",
          accountId: credentials.accountId,
          repository: repository!,
          branch: "main",
          client,
          journal,
        });
        const localRoot = `${evidence}/local-workspace`;
        yield* fs.makeDirectory(localRoot);
        yield* fs.writeFileString(`${localRoot}/README.md`, "LOCAL_ONLY_SENTINEL_DO_NOT_UPLOAD");
        const inference = yield* Effect.acquireRelease(
          Effect.promise(async () => {
            const server = NodeHttp.createServer((request, response) => {
              request.resume();
              request.on("end", () => {
                response.writeHead(200, { "content-type": "text/event-stream" });
                for (const delta of [{ content: "LOCAL_ONLY_SENTINEL_DO_NOT_UPLOAD" }, {}])
                  response.write(
                    `data: ${JSON.stringify({ id: "local", object: "chat.completion.chunk", created: 0, model: "test", choices: [{ index: 0, delta, finish_reason: Object.keys(delta).length ? null : "stop" }] })}\n\n`,
                  );
                response.end("data: [DONE]\n\n");
              });
            });
            server.listen(0, "127.0.0.1");
            await NodeEvents.EventEmitter.once(server, "listening");
            const address = server.address();
            if (!address || typeof address === "string")
              throw new Error("Missing local fixture address");
            return { server, url: `http://127.0.0.1:${address.port}/v1` };
          }),
          ({ server }) =>
            Effect.promise(
              () =>
                new Promise<void>((resolve) => {
                  server.closeAllConnections();
                  server.close(() => resolve());
                }),
            ),
        );
        const localInstance = ProviderInstanceId.make("kilo-local-parallel");
        const localThreadId = ThreadId.make("kilo-local-parallel");
        const localModel = { instanceId: localInstance, model: "fixture/test", options: [] };
        const runtime = yield* LocalRuntime.make({
          instanceId: "parallel-local",
          binaryPath: process.env.KILO_BIN!,
          profileDirectory: `${evidence}/local-profile`,
          environment: {
            PATH: process.env.PATH,
            HTTP_PROXY: process.env.HTTP_PROXY,
            HTTPS_PROXY: process.env.HTTPS_PROXY,
            NO_PROXY: process.env.NO_PROXY,
            NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
            KILO_DISABLE_AUTOUPDATE: "1",
            KILO_DISABLE_MODELS_FETCH: "1",
            KILO_DISABLE_DEFAULT_PLUGINS: "1",
            KILO_DISABLE_EXTERNAL_SKILLS: "1",
            KILO_DISABLE_PROJECT_CONFIG: "1",
            KILO_CONFIG_CONTENT: json({
              model: "fixture/test",
              small_model: "fixture/test",
              plugin: [],
              enabled_providers: ["fixture"],
              provider: {
                fixture: {
                  npm: "@ai-sdk/openai-compatible",
                  name: "Local",
                  options: { baseURL: inference.url },
                  models: { test: { name: "Local", limit: { context: 10000, output: 1000 } } },
                },
              },
            }),
          },
        });
        const localAdapter = yield* LocalAdapter.make({
          instanceId: localInstance,
          continuationKey: "parallel-local",
          cwd: localRoot,
          runtime,
          attachmentsDir: `${evidence}/attachments`,
        });
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const terminals = [yield* Deferred.make<void>(), yield* Deferred.make<void>()];
          const seen = new Set<string>();
          const localDone = yield* Deferred.make<void>();
          const timing: Array<{ type: string; threadId: string; status: string; at: number }> = [];
          yield* orchestrator.streamStoredEvents.pipe(
            Stream.runForEach(({ event }) =>
              Effect.gen(function* () {
                if (event.type === "run.updated")
                  timing.push({
                    type: event.type,
                    threadId: event.threadId,
                    status: event.payload.status,
                    at: yield* Clock.currentTimeMillis,
                  });
                if (
                  event.type === "run.updated" &&
                  event.threadId === localThreadId &&
                  ["completed", "failed", "interrupted"].includes(event.payload.status)
                )
                  yield* Deferred.succeed(localDone, undefined);
                if (
                  event.threadId === threadId &&
                  event.type === "run.updated" &&
                  ["completed", "failed", "interrupted"].includes(event.payload.status) &&
                  !seen.has(event.payload.id)
                ) {
                  seen.add(event.payload.id);
                  const terminal = terminals[seen.size - 1];
                  if (terminal) yield* Deferred.succeed(terminal, undefined);
                }
              }),
            ),
            Effect.forkScoped,
          );
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("cloud-live-create"),
            createdBy: "user",
            creationSource: "web",
            threadId,
            projectId: ProjectId.make("synthetic"),
            title: "Read-only cloud integration",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: `${evidence}/LOCAL-FILES-MUST-NOT-BE-READ`,
          });
          const prompts = [
            "Read only README.md and list the top-level file names in this synthetic repository. Reply with a brief summary. Do not execute shell commands, edit files, commit, open a PR, access the network, or start subagents.",
            "Using only the context already read, repeat one top-level file name. Do not use tools, modify files, commit, or open a PR. Keep the answer to one line.",
          ];
          for (let index = 0; index < prompts.length; index++) {
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(`cloud-live-send-${index}`),
              createdBy: "user",
              creationSource: "web",
              threadId,
              messageId: MessageId.make(`cloud-live-user-${index}`),
              text: prompts[index]!,
              attachments: [],
              modelSelection,
              dispatchMode: { type: "start_immediately" },
            });
            if (index === 0) {
              yield* orchestrator.dispatch({
                type: "thread.create",
                commandId: CommandId.make("local-create"),
                createdBy: "user",
                creationSource: "web",
                threadId: localThreadId,
                projectId: ProjectId.make("local"),
                title: "Parallel local isolation",
                modelSelection: localModel,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: null,
                worktreePath: localRoot,
              });
              yield* orchestrator.dispatch({
                type: "message.dispatch",
                commandId: CommandId.make("local-send"),
                createdBy: "user",
                creationSource: "web",
                threadId: localThreadId,
                messageId: MessageId.make("local-user"),
                text: "Say local hello",
                attachments: [],
                modelSelection: localModel,
                dispatchMode: { type: "start_immediately" },
              });
            }
            yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
            yield* Deferred.await(terminals[index]!);
            const projection = yield* orchestrator.getThreadProjection(threadId);
            yield* fs.writeFileString(`${evidence}/turn-${index}.json`, json(projection));
            assert.equal(projection.runs.at(-1)?.status, "completed");
            assert.equal(projection.checkpoints.length, 0);
            assert.isFalse(
              projection.messages.some((message) => message.text.includes("LOCAL_ONLY_SENTINEL")),
            );
            assert.isFalse(yield* fs.exists(`${evidence}/LOCAL-FILES-MUST-NOT-BE-READ`));
            assert.isTrue(
              projection.messages.some(
                (message) => message.role === "assistant" && message.text.length > 0,
              ),
            );
          }
          yield* Deferred.await(localDone);
          const localProjection = yield* orchestrator.getThreadProjection(localThreadId);
          yield* fs.writeFileString(
            `${evidence}/parallel-local.json`,
            json({ projection: localProjection, timing }),
          );
          assert.equal(localProjection.runs.at(-1)?.status, "completed");
          assert.isTrue(
            localProjection.messages.some((message) =>
              message.text.includes("LOCAL_ONLY_SENTINEL"),
            ),
          );
          assert.isFalse(
            localProjection.providerThreads.some((thread) => thread.driver === "kilo-cloud"),
          );
        }).pipe(
          Effect.provide(
            makeOrchestratorV2ReplayLayerWithRegistry(
              {
                name: "kilo-cloud-paid",
              },
              Registry.makeLayer([adapter, localAdapter]),
            ),
          ),
        );
        const entries = yield* journal.read;
        const binding = entries.at(-1)?.binding;
        if (!binding)
          return yield* Effect.die(
            new Error("No cloud binding; inspect durable admission before any retry."),
          );
        yield* fs.writeFileString(
          `${evidence}/lifecycle-after.json`,
          json({
            binding,
            sandbox: yield* client.sandbox(binding),
            billing: yield* client.billing(binding),
          }),
        );
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, IdAllocator.layer))),
    240_000,
  );
});

const recovery = process.env.KILO_CLOUD_RECOVER_EVIDENCE;
describe.skipIf(!profile || !recovery)("read-only Kilo Cloud recovery", () => {
  it.live(
    "reconciles a saved admission through the adapter without resubmitting",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const account = yield* Account.make(profile!);
        const credentials = yield* account.load;
        const journal = yield* Journal.make(`${recovery}/journal`);
        const intent = (yield* journal.read).at(-1);
        if (!intent || !intent.binding)
          return yield* Effect.die(new Error("Missing saved cloud admission"));
        assert.equal(intent.accountId, credentials.accountId);
        const client = Cloud.make({ ...credentials, credentials: account.load });
        const adapter = yield* CloudAdapter.make({
          instanceId: intent.providerThread.providerInstanceId,
          continuationKey: intent.providerThread.nativeMetadata!.continuationKey!,
          accountId: credentials.accountId,
          repository: intent.repository,
          branch: intent.branch,
          client,
          journal,
        });
        const session = yield* adapter.openSession({
          threadId: intent.providerThread.appThreadId!,
          providerSessionId: intent.providerThread.providerSessionId!,
          modelSelection: {
            instanceId: intent.providerThread.providerInstanceId,
            model: "deepseek/deepseek-v4.1-flash",
          },
          runtimePolicy: {
            runtimeMode: "approval-required",
            interactionMode: "default",
            cwd: null,
          },
        });
        const thread = yield* session.resumeThread({ providerThread: intent.providerThread });
        const snapshot = yield* session.readThreadSnapshot({ providerThread: thread });
        const saved = (yield* journal.read).at(-1)!;
        yield* fs.writeFileString(
          `${recovery}/recovered.json`,
          json({
            state: saved.state,
            operationKey: saved.operationKey,
            messageId: saved.messageId,
            snapshot,
            sandbox: yield* client.sandbox(intent.binding),
            billing: yield* client.billing(intent.binding),
          }),
        );
        assert.isTrue(["completed", "failed", "interrupted"].includes(saved.state));
        assert.equal(saved.operationKey, intent.operationKey);
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, IdAllocator.layer))),
    60_000,
  );
});

const controlEvidence = process.env.KILO_CLOUD_CONTROL_EVIDENCE;
describe.skipIf(
  !profile || !controlEvidence || process.env.KILO_CLOUD_ALLOW_FULL_ACCESS_READ_ONLY_TEST !== "yes",
)("paid existing-session interrupt", () => {
  it.live(
    "restores native history and confirms remote interruption in the same cloud worktree",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(`${controlEvidence}/interrupt-admission`);
        const projection = yield* decodeProjection(
          yield* fs.readFileString(`${controlEvidence}/turn-1.json`),
        );
        const journal = yield* Journal.make(`${controlEvidence}/journal`);
        const prior = (yield* journal.read).at(-1)!;
        assert.equal(prior.state, "completed");
        const account = yield* Account.make(profile!);
        const credentials = yield* account.load;
        assert.equal(credentials.accountId, prior.accountId);
        const client = Cloud.make({ ...credentials, credentials: account.load });
        const adapter = yield* CloudAdapter.make({
          instanceId: prior.providerThread.providerInstanceId,
          continuationKey: prior.providerThread.nativeMetadata!.continuationKey!,
          accountId: credentials.accountId,
          repository: prior.repository,
          branch: prior.branch,
          client,
          journal,
        });
        const runtimePolicy = {
          runtimeMode: "full-access" as const,
          interactionMode: "default" as const,
          cwd: null,
        };
        const session = yield* adapter.openSession({
          threadId: projection.thread.id,
          providerSessionId: prior.providerThread.providerSessionId!,
          modelSelection: projection.thread.modelSelection,
          runtimePolicy,
        });
        const thread = yield* session.resumeThread({ providerThread: prior.providerThread });
        const restored = yield* session.readThreadSnapshot({ providerThread: thread });
        assert.isTrue(restored.messages.some((message) => message.text === "fixture.py"));
        const terminal = yield* Deferred.make<Adapter.ProviderAdapterV2Event>();
        yield* session.events.pipe(
          Stream.runForEach((event) =>
            event.type === "turn.terminal"
              ? Deferred.succeed(terminal, event).pipe(Effect.asVoid)
              : Effect.void,
          ),
          Effect.forkScoped,
        );
        yield* session.startTurn({
          appThread: projection.thread,
          threadId: projection.thread.id,
          providerThread: thread,
          runId: RunId.make("cloud-stop-test"),
          runOrdinal: 3,
          providerTurnOrdinal: 3,
          attemptId: RunAttemptId.make("cloud-stop-test"),
          rootNodeId: NodeId.make("cloud-stop-test"),
          message: {
            messageId: MessageId.make("cloud-stop-test"),
            text: "Read-only interruption check: count from one to 200, one number per line. Do not use tools, modify files, commit, open a PR, or start subagents.",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
          modelSelection: projection.thread.modelSelection,
          runtimePolicy,
        });
        const admitted = (yield* journal.read).at(-1)!;
        assert.equal(admitted.binding?.worktreeId, prior.binding?.worktreeId);
        yield* session.interruptTurn({
          providerThread: thread,
          providerTurnId: admitted.providerTurn.id,
        });
        const event = yield* Deferred.await(terminal);
        const result = yield* client.result(admitted.binding!, admitted.messageId);
        yield* fs.writeFileString(
          `${controlEvidence}/interrupt-result.json`,
          json({
            event,
            result,
            sandbox: yield* client.sandbox(admitted.binding!),
            billing: yield* client.billing(admitted.binding!),
          }),
        );
        assert.equal(result?.status, "interrupted");
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, IdAllocator.layer))),
    90_000,
  );
});
