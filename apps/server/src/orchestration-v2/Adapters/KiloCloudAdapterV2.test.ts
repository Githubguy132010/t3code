// @effect-diagnostics nodeBuiltinImport:off - external customer API contract over a loopback socket.
import * as NodeHttp from "node:http";
import * as NodeEvents from "node:events";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ProviderSessionId,
  ProviderThreadId,
  RunId,
  RunAttemptId,
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as Cloud from "../../provider/kilo/KiloCloudWebClient.ts";
import * as Journal from "../../provider/kilo/KiloCloudJournal.ts";
import * as IdAllocator from "../IdAllocator.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as EffectWorker from "../EffectWorker.ts";
import * as Registry from "../ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "../testkit/ProviderReplayHarness.ts";
import type * as Adapter from "../ProviderAdapter.ts";
import * as CloudAdapter from "./KiloCloudAdapterV2.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const fixture = Effect.acquireRelease(
  Effect.promise(async () => {
    let submissions = 0;
    let signalInterrupt!: () => void;
    const interruptSeen = new Promise<void>((resolve) => {
      signalInterrupt = resolve;
    });
    const control = {
      status: "completed",
      missingHistory: false,
      incompleteHistory: false,
      interruptAccepted: false,
      interruptPosts: 0,
      permission: false,
      question: false,
      questionPosts: 0,
      questionAnswers: null as unknown,
      answerAccepted: false,
      answerPosts: 0,
    };
    const conversations = new Map<
      string,
      {
        cloud: string;
        native: string;
        worktree: string;
        initial: string;
        messages: Array<{ id: string; prompt: string }>;
      }
    >();
    const server = NodeHttp.createServer((request, response) => {
      let raw = "";
      request.on("data", (chunk) => {
        raw += String(chunk);
      });
      request.on("end", () => {
        const url = new URL(request.url!, "http://localhost");
        const operation = url.pathname.split("/").at(-1)!;
        const input = JSON.parse(raw || url.searchParams.get("input") || "{}") as Record<
          string,
          string
        >;
        const reply = (data: unknown) => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ result: { data } }));
        };
        if (operation.startsWith("agentProfiles.")) return reply([]);
        if (operation === "cloudAgentNext.prepareSession") {
          submissions++;
          const suffix = String(submissions).padStart(12, "0");
          const state = {
            cloud: `workspace_12345678-1234-1234-1234-${suffix}`,
            native: `ses_fixture${submissions}`,
            worktree: `worktree_12345678-1234-1234-1234-${suffix}`,
            initial: input.initialMessageId!,
            messages: [{ id: input.initialMessageId!, prompt: input.prompt! }],
          };
          conversations.set(state.cloud, state);
          return reply({ cloudAgentSessionId: state.cloud, kiloSessionId: state.native });
        }
        const state = [...conversations.values()].find(
          (item) => item.cloud === input.cloudAgentSessionId || item.native === input.session_id,
        );
        if (operation === "cloudAgentNext.interruptSession") {
          control.interruptPosts++;
          signalInterrupt();
          if (control.interruptAccepted) control.status = "interrupted";
          return reply({ success: control.interruptAccepted });
        }
        if (operation === "cloudAgentNext.answerQuestion") {
          control.questionPosts++;
          control.questionAnswers = input.answers;
          control.question = false;
          return reply({ success: true });
        }
        if (operation === "cloudAgentNext.answerPermission") {
          control.answerPosts++;
          if (control.answerAccepted) control.permission = false;
          return reply({ success: control.answerAccepted });
        }
        if (!state) {
          response.writeHead(404);
          response.end();
          return;
        }
        if (operation === "cloudAgentNext.getSession")
          return reply({
            sessionId: state.cloud,
            kiloSessionId: state.native,
            worktreeId: state.worktree,
            userId: "fixture-account",
            githubRepo: "fixture/repo",
            upstreamBranch: "main",
            autoCommit: false,
            initialMessageId: state.initial,
            execution: null,
          });
        if (operation === "cloudAgentNext.sendMessage") {
          const payload = input.payload as unknown as { prompt: string };
          state.messages.push({ id: input.messageId!, prompt: payload.prompt });
          return reply({
            cloudAgentSessionId: state.cloud,
            messageId: input.messageId,
            status: "started",
            delivery: "sent",
          });
        }
        if (operation === "cloudAgentNext.getPendingInteractions")
          return reply({
            permissions: control.permission
              ? [
                  {
                    id: "permission-fixture",
                    sessionID: state.native,
                    permission: "read",
                    patterns: ["README.md"],
                  },
                ]
              : [],
            questions: control.question
              ? [
                  {
                    id: "question-fixture",
                    sessionID: state.native,
                    questions: [
                      {
                        header: "Files",
                        question: "Which files?",
                        multiple: true,
                        custom: false,
                        options: [
                          { label: "README.md", description: "Documentation" },
                          { label: "fixture.py", description: "Synthetic code" },
                        ],
                      },
                    ],
                  },
                ]
              : [],
          });
        if (operation === "cloudAgentNext.getMessageResult")
          return reply({
            cloudAgentSessionId: state.cloud,
            messageId: input.messageId,
            status: control.status,
          });
        if (operation === "cliSessionsV2.getSessionMessagesPage" && control.missingHistory)
          return reply({ kiloSessionId: state.native, history: null, watermarkEventId: 49 });
        if (operation === "cliSessionsV2.getSessionMessagesPage")
          return reply({
            kiloSessionId: state.native,
            watermarkEventId: 3,
            history: {
              nextCursor: null,
              omittedItemCount: 0,
              messages: state.messages.flatMap((message) => [
                {
                  info: {
                    id: message.id,
                    sessionID: state.native,
                    role: "user",
                    time: { created: 1 },
                  },
                  parts: [
                    {
                      id: `part-${message.id}`,
                      messageID: message.id,
                      sessionID: state.native,
                      type: "text",
                      text: message.prompt,
                    },
                  ],
                },
                {
                  info: {
                    id: `reply-${message.id}`,
                    sessionID: state.native,
                    role: "assistant",
                    finish: "stop",
                    parentID: message.id,
                    time:
                      control.incompleteHistory && message !== state.messages[0]
                        ? { created: 2 }
                        : { created: 2, completed: 3 },
                  },
                  parts: [
                    {
                      id: `part-reply-${message.id}`,
                      messageID: `reply-${message.id}`,
                      sessionID: state.native,
                      type: "text",
                      text: `Remote reply: ${message.prompt}`,
                    },
                  ],
                },
              ]),
            },
          });
        response.writeHead(400);
        response.end();
      });
    });
    server.listen(0, "127.0.0.1");
    await NodeEvents.EventEmitter.once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No fixture address");
    return {
      origin: `http://127.0.0.1:${address.port}`,
      submissions: () => submissions,
      conversations,
      control,
      interruptSeen,
      close: async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  }),
  (fixture) => Effect.promise(fixture.close),
);

it.live(
  "completes two isolated cloud threads through SQLite orchestration without touching local workspaces",
  () =>
    Effect.gen(function* () {
      const remote = yield* fixture;
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const journal = yield* Journal.make(directory);
      const instanceId = ProviderInstanceId.make("cloud-test");
      const modelSelection = { instanceId, model: "fixture/model" };
      let restore: Adapter.ProviderAdapterV2TurnInput | undefined;
      const adapterOptions = {
        instanceId,
        continuationKey: "fixture-account-repo",
        accountId: "fixture-account",
        repository: "fixture/repo",
        branch: "main",
        client: Cloud.make({
          accountId: "fixture-account",
          token: Redacted.make("fixture-token"),
          origin: remote.origin,
        }),
        journal,
      };
      const adapter = yield* CloudAdapter.make(adapterOptions);
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const done = yield* Deferred.make<void>();
        const completed = new Set<string>();
        yield* orchestrator.streamStoredEvents.pipe(
          Stream.runForEach(({ event }) => {
            if (
              event.type === "run.updated" &&
              ["completed", "failed", "interrupted"].includes(event.payload.status)
            )
              completed.add(event.threadId);
            return completed.size === 2
              ? Deferred.succeed(done, undefined).pipe(Effect.asVoid)
              : Effect.void;
          }),
          Effect.forkScoped,
        );
        for (const suffix of ["a", "b"]) {
          const threadId = ThreadId.make(`cloud-${suffix}`);
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`create-${suffix}`),
            createdBy: "user",
            creationSource: "web",
            threadId,
            projectId: ProjectId.make("cloud-project"),
            title: "Cloud contract",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: `${directory}/must-not-exist-${suffix}`,
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`send-${suffix}`),
            createdBy: "user",
            creationSource: "web",
            threadId,
            messageId: MessageId.make(`user-${suffix}`),
            text: `isolation-${suffix}`,
            attachments: [],
            modelSelection,
            dispatchMode: { type: "start_immediately" },
          });
        }
        yield* (yield* EffectWorker.OrchestrationEffectWorkerV2).drain();
        yield* Deferred.await(done);
        for (const suffix of ["a", "b"]) {
          const projection = yield* orchestrator.getThreadProjection(
            ThreadId.make(`cloud-${suffix}`),
          );
          assert.equal(
            projection.runs[0]?.status,
            "completed",
            yield* encodeJson(projection.turnItems),
          );
          assert.isNotNull(projection.runs[0]?.completedAt);
          assert.isTrue(
            projection.messages.some(
              (message) =>
                message.role === "assistant" &&
                message.text === `Remote reply: isolation-${suffix}`,
            ),
          );
          assert.isFalse(
            projection.messages.some((message) =>
              message.text.includes(`isolation-${suffix === "a" ? "b" : "a"}`),
            ),
          );
          assert.isFalse(yield* fs.exists(`${directory}/must-not-exist-${suffix}`));
          assert.equal(projection.checkpoints.length, 0);
          if (suffix === "a") {
            const run = projection.runs[0];
            const providerThread = projection.providerThreads[0];
            if (!run?.rootNodeId || !run.activeAttemptId || !providerThread)
              return yield* Effect.die(new Error("Missing persisted turn"));
            restore = {
              appThread: projection.thread,
              threadId: projection.thread.id,
              runId: run.id,
              runOrdinal: run.ordinal,
              providerTurnOrdinal: 1,
              attemptId: run.activeAttemptId,
              rootNodeId: run.rootNodeId,
              providerThread,
              message: {
                messageId: MessageId.make("user-a"),
                text: "MUST NOT BE RESUBMITTED",
                attachments: [],
                createdBy: "user",
                creationSource: "web",
              },
              modelSelection,
              runtimePolicy: {
                runtimeMode: "full-access",
                interactionMode: "default",
                cwd: null,
              },
              reattach: true,
            };
          }
        }
      }).pipe(
        Effect.provide(
          makeOrchestratorV2ReplayLayerWithRegistry(
            { name: "kilo-cloud-contract" },
            Registry.makeSingleLayer({
              ...adapter,
              openSession: (input) =>
                adapter.openSession(input).pipe(
                  Effect.map((runtime) => ({
                    ...runtime,
                    startTurn: (input) =>
                      runtime
                        .startTurn(input)
                        .pipe(
                          Effect.catchCause((cause) =>
                            Effect.logError(Cause.pretty(cause)).pipe(
                              Effect.andThen(Effect.failCause(cause)),
                            ),
                          ),
                        ),
                  })),
                ),
            }),
          ),
        ),
      );
      assert.equal(remote.submissions(), 2);
      const entries = yield* journal.read;
      assert.equal(entries.length, 2);
      assert.equal(new Set(entries.map((entry) => entry.binding?.worktreeId)).size, 2);
      assert.isTrue(entries.every((entry) => entry.state === "completed"));
      if (!restore) return yield* Effect.die(new Error("Missing restore input"));
      // Simulate loss of the terminal T3 event after the durable journal commit.
      // Reattaching a fresh runtime must replay terminality without another paid POST.
      const restored = yield* adapter.openSession({
        threadId: restore.threadId,
        providerSessionId: ProviderSessionId.make("cloud-restored"),
        modelSelection,
        runtimePolicy: restore.runtimePolicy,
      });
      const restoredThread = yield* restored.ensureThread({
        threadId: restore.threadId,
        existingProviderThread: restore.providerThread,
        modelSelection,
        runtimePolicy: restore.runtimePolicy,
      });
      const terminal = yield* Deferred.make<Adapter.ProviderAdapterV2Event>();
      const replayedMessages: string[] = [];
      const restoredEvents = yield* restored.events.pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            if (event.type === "message.updated") replayedMessages.push(event.message.text);
            if (event.type === "turn.terminal") yield* Deferred.succeed(terminal, event);
          }),
        ),
        Effect.forkScoped,
      );
      yield* restored.startTurn({ ...restore, providerThread: restoredThread });
      const event = yield* Deferred.await(terminal);
      assert.isTrue(event.type === "turn.terminal" && event.status === "completed");
      assert.include(replayedMessages, "Remote reply: isolation-a");
      assert.equal(remote.submissions(), 2);
      const restricted = yield* restored
        .startTurn({
          ...restore,
          reattach: false,
          providerThread: restoredThread,
          runtimePolicy: { ...restore.runtimePolicy, runtimeMode: "approval-required" },
        })
        .pipe(Effect.flip);
      assert.include(restricted.message, "cannot enforce restricted permissions");
      assert.equal(remote.submissions(), 2);
      assert.equal((yield* journal.read).length, 2);
      yield* Fiber.interrupt(restoredEvents);
      remote.control.status = "running";
      remote.control.permission = true;
      remote.control.question = true;
      remote.control.incompleteHistory = true;
      const pendingRequest =
        yield* Deferred.make<
          Extract<Adapter.ProviderAdapterV2Event, { type: "runtime_request.updated" }>
        >();
      const pendingQuestion =
        yield* Deferred.make<
          Extract<Adapter.ProviderAdapterV2Event, { type: "runtime_request.updated" }>
        >();
      const questionResolved = yield* Deferred.make<void>();
      const resolvedItems: Array<Adapter.ProviderAdapterV2Event> = [];
      const failedWithoutHistory = yield* Deferred.make<void>();
      yield* restored.events.pipe(
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            resolvedItems.push(event);
            if (
              event.type === "turn_item.updated" &&
              event.turnItem.type === "user_input_request" &&
              event.turnItem.status === "completed"
            )
              yield* Deferred.succeed(questionResolved, undefined);
            if (event.type === "turn.terminal" && event.status === "failed")
              yield* Deferred.succeed(failedWithoutHistory, undefined);
            if (
              event.type === "runtime_request.updated" &&
              event.runtimeRequest.status === "pending"
            )
              yield* Deferred.succeed(
                event.runtimeRequest.kind === "user_input" ? pendingQuestion : pendingRequest,
                event,
              );
          }),
        ),
        Effect.forkScoped,
      );
      yield* restored.startTurn({
        ...restore,
        reattach: false,
        providerThread: restoredThread,
        runId: RunId.make("followup-run"),
        attemptId: RunAttemptId.make("followup-attempt"),
        runOrdinal: 2,
        providerTurnOrdinal: 2,
        message: {
          ...restore.message,
          messageId: MessageId.make("followup"),
          text: "Follow up in the same workspace",
        },
      });
      const question = yield* Deferred.await(pendingQuestion);
      const unanswered = yield* restored
        .respondToRuntimeRequest({ requestId: question.runtimeRequest.id, answers: {} })
        .pipe(Effect.flip);
      assert.include(unanswered.message, "requires an answer");
      assert.equal(remote.control.questionPosts, 0);
      yield* restored.respondToRuntimeRequest({
        requestId: question.runtimeRequest.id,
        answers: { "0": ["README.md", "fixture.py"] },
      });
      yield* Deferred.await(questionResolved);
      assert.equal(remote.control.questionPosts, 1);
      assert.deepEqual(remote.control.questionAnswers, [["README.md", "fixture.py"]]);
      assert.isTrue(
        resolvedItems.some(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "user_input_request" &&
            event.turnItem.questions[0]?.multiSelect === true &&
            event.turnItem.questions[0]?.allowCustomAnswer === false,
        ),
      );
      assert.isTrue(
        resolvedItems.some(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "user_input_request" &&
            event.turnItem.status === "completed",
        ),
      );
      const pending = yield* Deferred.await(pendingRequest);
      yield* restored
        .respondToRuntimeRequest({ requestId: pending.runtimeRequest.id, decision: "accept" })
        .pipe(Effect.flip);
      remote.control.answerAccepted = true;
      yield* restored.respondToRuntimeRequest({
        requestId: pending.runtimeRequest.id,
        decision: "accept",
      });
      assert.equal(remote.control.answerPosts, 2);
      const currentTurn = (yield* journal.read).at(-1)!;
      // A definite rejection permits an explicit retry. It is never an automatic resend.
      const rejectedStop = yield* restored
        .interruptTurn({
          providerThread: restoredThread,
          providerTurnId: currentTurn.providerTurn.id,
        })
        .pipe(Effect.forkScoped);
      yield* Effect.promise(() => remote.interruptSeen);
      remote.control.interruptAccepted = true;
      yield* restored.interruptTurn({
        providerThread: restoredThread,
        providerTurnId: currentTurn.providerTurn.id,
      });
      yield* Fiber.join(rejectedStop);
      assert.equal(remote.control.interruptPosts, 2);
      assert.equal(remote.submissions(), 2);
      assert.isTrue(
        resolvedItems.some(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "approval_request" &&
            event.turnItem.status === "completed",
        ),
      );
      // Reopening with paid admission disabled still restores control and native
      // history; incomplete records from an interrupted turn must stay terminal.
      const controlOnly = yield* CloudAdapter.make({ ...adapterOptions, allowAdmission: false });
      const reopened = yield* controlOnly.openSession({
        threadId: restore.threadId,
        providerSessionId: ProviderSessionId.make("cloud-control-only"),
        modelSelection,
        runtimePolicy: restore.runtimePolicy,
      });
      const reopenedThread = yield* reopened.resumeThread({ providerThread: restoredThread });
      const snapshot = yield* reopened.readThreadSnapshot({ providerThread: reopenedThread });
      assert.isTrue(
        snapshot.messages.some(
          (message) => message.text === "Remote reply: Follow up in the same workspace",
        ),
      );
      assert.isTrue(snapshot.messages.every((message) => !message.streaming));
      const denied = yield* reopened
        .startTurn({ ...restore, providerThread: reopenedThread, reattach: false })
        .pipe(Effect.flip);
      assert.include(denied.message, "Paid cloud execution is disabled");
      assert.equal(remote.submissions(), 2);
      remote.control.status = "failed";
      remote.control.missingHistory = true;
      yield* restored.startTurn({
        ...restore,
        reattach: false,
        providerThread: restoredThread,
        runId: RunId.make("failed-run"),
        attemptId: RunAttemptId.make("failed-attempt"),
        runOrdinal: 3,
        providerTurnOrdinal: 3,
        message: {
          ...restore.message,
          messageId: MessageId.make("failed"),
          text: "Bootstrap failure has no history",
        },
      });
      yield* Deferred.await(failedWithoutHistory);
      assert.equal((yield* journal.read).at(-1)?.state, "failed");
      assert.equal(remote.submissions(), 2);
      const first = (yield* journal.read)[0]!;
      yield* journal.save({ ...first, interruptRequested: true });
      assert.equal((yield* replacementForStale()).operation, "write");
      function replacementForStale() {
        return journal.save({ ...first, interruptRequested: false }).pipe(Effect.flip);
      }
      assert.equal(
        (yield* journal.save({ ...first, accountId: "another-account" }).pipe(Effect.flip))
          .operation,
        "write",
      );
      assert.equal(
        (yield* journal.save({ ...first, state: "active" }).pipe(Effect.flip)).operation,
        "write",
      );
      const replacement = yield* Journal.make(directory);
      const concurrent = {
        ...first,
        state: "admission_unknown" as const,
        providerThread: {
          ...first.providerThread,
          id: ProviderThreadId.make("same-racing-thread"),
        },
      };
      const reservations = yield* Effect.all(
        [
          journal.reserve({ ...concurrent, operationKey: "race-a" }),
          replacement.reserve({ ...concurrent, operationKey: "race-b" }),
        ],
        { concurrency: "unbounded" },
      );
      assert.equal(reservations.filter(Boolean).length, 1);
      assert.equal(
        (yield* replacement.read).filter(
          (entry) => entry.providerThread.id === concurrent.providerThread.id,
        ).length,
        1,
      );
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, IdAllocator.layer))),
  30_000,
);
