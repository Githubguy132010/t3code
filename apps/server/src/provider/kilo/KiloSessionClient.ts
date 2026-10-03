import { createKiloClient, type Event, type KiloClient } from "@kilocode/sdk/v2";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

/** Persist with the T3 session. A native id alone is not an account or workspace identity. */
const KiloSessionRef = Schema.Struct({
  instanceId: Schema.NonEmptyString,
  directory: Schema.NonEmptyString,
  sessionId: Schema.NonEmptyString,
});
export type KiloSessionRef = typeof KiloSessionRef.Type;

export class KiloSessionError extends Schema.TaggedError<KiloSessionError>()("KiloSessionError", {
  operation: Schema.String,
  reason: Schema.Literals([
    "request_failed",
    "admission_unknown",
    "wrong_owner",
    "unsupported_version",
    "invalid_response",
  ]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Kilo ${this.operation} failed (${this.reason}).`;
  }
}

const Health = Schema.Struct({ healthy: Schema.Literal(true), version: Schema.Literal("7.8.3") });
const decodeHealth = Schema.decodeUnknownEffect(Health);

const SessionOwner = Schema.Struct({ id: Schema.NonEmptyString, directory: Schema.String });
const PendingOwners = Schema.Array(
  Schema.Struct({ id: Schema.NonEmptyString, sessionID: Schema.NonEmptyString }),
);
const EventEnvelope = Schema.Struct({
  type: Schema.NonEmptyString,
  properties: Schema.Record(Schema.String, Schema.Unknown),
});

const isKiloSessionError = Schema.is(KiloSessionError);
const isSyncEnvelope = Schema.is(
  Schema.Struct({
    type: Schema.Literal("sync"),
    syncEvent: Schema.Record(Schema.String, Schema.Unknown),
  }),
);
const isSessionOwner = Schema.is(SessionOwner);
const isPendingOwners = Schema.is(PendingOwners);
const isEventEnvelope = Schema.is(EventEnvelope);
const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));

function sessionIdOf(event: Event): Effect.Effect<string | undefined, KiloSessionError> {
  // The server also sends replication envelopes omitted from its generated Event union.
  // Ordinary session/message events follow these and remain the source for this stream.
  if (isSyncEnvelope(event)) return Effect.succeed(undefined);
  if (!isEventEnvelope(event)) {
    return Effect.fail(
      new KiloSessionError({ operation: "event.subscribe", reason: "invalid_response" }),
    );
  }
  const properties = event.properties;
  let value: unknown;
  if ("sessionID" in properties) value = properties.sessionID;
  else if (event.type === "message.part.updated") {
    value = isRecord(properties.part) ? properties.part.sessionID : undefined;
  } else if (event.type === "message.updated") {
    value = isRecord(properties.info) ? properties.info.sessionID : undefined;
  } else if (
    event.type === "session.created" ||
    event.type === "session.updated" ||
    event.type === "session.deleted"
  ) {
    value = isRecord(properties.info) ? properties.info.id : undefined;
  } else if (event.type === "session.error") {
    return Effect.fail(
      new KiloSessionError({ operation: "event.subscribe", reason: "request_failed" }),
    );
  } else {
    // Directory streams include global config, PTY and health events. Their `info`
    // fields are not session records and must not terminate unrelated sessions.
    return Effect.succeed(undefined);
  }
  if (typeof value !== "string" || value.length === 0) {
    return Effect.fail(
      new KiloSessionError({ operation: "event.subscribe", reason: "invalid_response" }),
    );
  }
  return Effect.succeed(value);
}

/**
 * One local Kilo provider instance and directory, using Kilo's SDK and auth/header conventions.
 * No ambient credentials, cloud routes, automatic retries of mutations, or global config writes.
 * The caller owns the server process and supplies its scoped loopback URL.
 * Account changes must invalidate the instance identity before restoring saved refs.
 */
export const make = Effect.fn("KiloSessionClient.make")(function* (input: {
  readonly instanceId: string;
  readonly directory: string;
  readonly baseUrl: string;
  readonly serverPassword?: string;
  readonly serverUsername?: string;
}) {
  const client = createKiloClient({
    baseUrl: input.baseUrl,
    directory: input.directory,
    throwOnError: true,
    // Mutation redirects must never forward an authorization header or repeat a prompt elsewhere.
    redirect: "error",
    ...(input.serverPassword === undefined
      ? {}
      : {
          headers: {
            Authorization: `Basic ${Buffer.from(`${input.serverUsername ?? "kilo"}:${input.serverPassword}`).toString("base64")}`,
          },
        }),
  });

  const request = <A>(operation: string, run: (signal: AbortSignal) => Promise<{ data?: A }>) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) => new KiloSessionError({ operation, reason: "request_failed", cause }),
    }).pipe(
      Effect.timeout("10 seconds"),
      Effect.catchTag(
        "TimeoutError",
        (cause) => new KiloSessionError({ operation, reason: "request_failed", cause }),
      ),
      Effect.flatMap((response) =>
        response.data === undefined
          ? Effect.fail(new KiloSessionError({ operation, reason: "invalid_response" }))
          : Effect.succeed(response.data),
      ),
    );

  const acknowledge = (operation: string) => (accepted: unknown) =>
    accepted === true
      ? Effect.void
      : Effect.fail(new KiloSessionError({ operation, reason: "invalid_response" }));

  const checkOwner = (ref: KiloSessionRef, operation: string) =>
    ref.instanceId !== input.instanceId || ref.directory !== input.directory
      ? Effect.fail(new KiloSessionError({ operation, reason: "wrong_owner" }))
      : Effect.void;

  // Kilo's GET /session/{id} can resolve an id from another directory. The SDK directory
  // header is routing context, not authorization. Check the returned owner before every mutation.
  const read = (ref: KiloSessionRef) =>
    checkOwner(ref, "session.get").pipe(
      Effect.andThen(
        request("session.get", (signal) =>
          client.session.get({ sessionID: ref.sessionId }, { signal }),
        ),
      ),
      Effect.flatMap((session) =>
        isSessionOwner(session) &&
        session.id === ref.sessionId &&
        session.directory === input.directory
          ? Effect.succeed(session)
          : Effect.fail(new KiloSessionError({ operation: "session.get", reason: "wrong_owner" })),
      ),
    );

  const owned = <A>(
    ref: KiloSessionRef,
    operation: string,
    run: (signal: AbortSignal) => Promise<{ data?: A }>,
  ) => read(ref).pipe(Effect.andThen(request(operation, run)));

  const reference = (session: { id: string; directory: string }): KiloSessionRef => ({
    instanceId: input.instanceId,
    directory: session.directory,
    sessionId: session.id,
  });

  const health = yield* request("global.health", (signal) => client.global.health({ signal })).pipe(
    Effect.flatMap((value) =>
      decodeHealth(value).pipe(
        Effect.mapError(
          (cause) =>
            new KiloSessionError({
              operation: "global.health",
              reason: "unsupported_version",
              cause,
            }),
        ),
      ),
    ),
  );

  return {
    version: health.version,
    models: () => request("provider.list", (signal) => client.provider.list(undefined, { signal })),
    agents: () => request("app.agents", (signal) => client.app.agents(undefined, { signal })),
    create: (
      permission: NonNullable<Parameters<KiloClient["session"]["create"]>[0]>["permission"],
    ) =>
      request("session.create", (signal) =>
        client.session.create(permission === undefined ? {} : { permission }, { signal }),
      ).pipe(
        Effect.flatMap((session) =>
          isSessionOwner(session) && session.directory === input.directory
            ? Effect.succeed(reference(session))
            : Effect.fail(
                new KiloSessionError({ operation: "session.create", reason: "wrong_owner" }),
              ),
        ),
      ),
    read,
    history: (ref: KiloSessionRef) =>
      owned(ref, "session.messages", (signal) =>
        client.session.messages({ sessionID: ref.sessionId }, { signal }),
      ),
    fork: (ref: KiloSessionRef, messageID?: string) =>
      owned(ref, "session.fork", (signal) =>
        client.session.fork(
          { sessionID: ref.sessionId, ...(messageID === undefined ? {} : { messageID }) },
          { signal },
        ),
      ).pipe(
        Effect.flatMap((session) =>
          isSessionOwner(session) && session.directory === input.directory
            ? Effect.succeed(reference(session))
            : Effect.fail(
                new KiloSessionError({ operation: "session.fork", reason: "wrong_owner" }),
              ),
        ),
      ),
    // Native revert can modify files. The orchestration adapter must coordinate it with
    // T3 checkpoints and exclude concurrent writers before exposing this operation.
    revert: (ref: KiloSessionRef, messageID: string) =>
      owned(ref, "session.revert", (signal) =>
        client.session.revert({ sessionID: ref.sessionId, messageID }, { signal }),
      ),
    prompt: (
      ref: KiloSessionRef,
      prompt: Omit<
        Parameters<KiloClient["session"]["promptAsync"]>[0],
        "sessionID" | "directory" | "workspace"
      >,
    ) =>
      read(ref).pipe(
        Effect.andThen(
          Effect.tryPromise({
            try: (signal) =>
              client.session.promptAsync(
                {
                  ...prompt,
                  sessionID: ref.sessionId,
                  directory: input.directory,
                },
                { signal },
              ),
            catch: (cause) =>
              new KiloSessionError({
                operation: "session.promptAsync",
                reason: "admission_unknown",
                cause,
              }),
          }).pipe(
            Effect.timeout("10 seconds"),
            Effect.catchTag(
              "TimeoutError",
              (cause) =>
                new KiloSessionError({
                  operation: "session.promptAsync",
                  reason: "admission_unknown",
                  cause,
                }),
            ),
          ),
        ),
        Effect.flatMap((response) =>
          response.response?.status === 204
            ? Effect.void
            : Effect.fail(
                new KiloSessionError({
                  operation: "session.promptAsync",
                  reason: "invalid_response",
                }),
              ),
        ),
      ),
    abort: (ref: KiloSessionRef) =>
      owned(ref, "session.abort", (signal) =>
        client.session.abort({ sessionID: ref.sessionId }, { signal }),
      ).pipe(
        Effect.flatMap((accepted) =>
          accepted === true
            ? Effect.void
            : Effect.fail(
                new KiloSessionError({ operation: "session.abort", reason: "invalid_response" }),
              ),
        ),
      ),
    replyPermission: (
      ref: KiloSessionRef,
      requestID: string,
      reply: "once" | "always" | "reject",
    ) =>
      owned(ref, "permission.list", (signal) => client.permission.list(undefined, { signal })).pipe(
        Effect.flatMap((pending) =>
          isPendingOwners(pending) &&
          pending.some((p) => p.id === requestID && p.sessionID === ref.sessionId)
            ? request("permission.reply", (signal) =>
                client.permission.reply({ requestID, reply }, { signal }),
              ).pipe(Effect.flatMap(acknowledge("permission.reply")))
            : Effect.fail(
                new KiloSessionError({ operation: "permission.reply", reason: "wrong_owner" }),
              ),
        ),
      ),
    replyQuestion: (ref: KiloSessionRef, requestID: string, answers: string[][]) =>
      owned(ref, "question.list", (signal) => client.question.list(undefined, { signal })).pipe(
        Effect.flatMap((pending) =>
          isPendingOwners(pending) &&
          pending.some((p) => p.id === requestID && p.sessionID === ref.sessionId)
            ? request("question.reply", (signal) =>
                client.question.reply({ requestID, answers }, { signal }),
              ).pipe(Effect.flatMap(acknowledge("question.reply")))
            : Effect.fail(
                new KiloSessionError({ operation: "question.reply", reason: "wrong_owner" }),
              ),
        ),
      ),
    events: (ref: KiloSessionRef) =>
      Stream.unwrap(
        read(ref).pipe(
          Effect.andThen(
            Effect.gen(function* () {
              const controller = new AbortController();
              yield* Effect.addFinalizer(() => Effect.sync(() => controller.abort()));
              let streamFailure: unknown;
              const subscription = yield* Effect.tryPromise({
                try: () =>
                  client.event.subscribe(undefined, {
                    signal: controller.signal,
                    sseMaxRetryAttempts: 0,
                    onSseError: (cause) => {
                      streamFailure = cause;
                    },
                  }),
                catch: (cause) =>
                  new KiloSessionError({
                    operation: "event.subscribe",
                    reason: "request_failed",
                    cause,
                  }),
              });
              const interruptible: AsyncIterable<Event> = {
                [Symbol.asyncIterator]() {
                  const iterator = subscription.stream[Symbol.asyncIterator]();
                  return {
                    next: () => iterator.next(),
                    return: async () => {
                      // Abort a pending reader.read before awaiting generator cleanup.
                      // A scope finalizer alone runs after fromAsyncIterable's finalizer.
                      controller.abort();
                      return iterator.return
                        ? iterator.return()
                        : { done: true as const, value: undefined };
                    },
                  };
                },
              };
              return Stream.fromAsyncIterable(
                interruptible,
                (cause) =>
                  new KiloSessionError({
                    operation: "event.subscribe",
                    reason: "request_failed",
                    cause,
                  }),
              ).pipe(
                Stream.timeout("45 seconds"),
                Stream.mapError((cause) =>
                  isKiloSessionError(cause)
                    ? cause
                    : new KiloSessionError({
                        operation: "event.subscribe",
                        reason: "request_failed",
                        cause,
                      }),
                ),
                Stream.filterEffect((event) =>
                  sessionIdOf(event).pipe(Effect.map((sessionId) => sessionId === ref.sessionId)),
                ),
                Stream.concat(
                  Stream.unwrap(
                    Effect.sync(() =>
                      Stream.fail(
                        new KiloSessionError({
                          operation: "event.subscribe",
                          reason: "request_failed",
                          cause: streamFailure,
                        }),
                      ),
                    ),
                  ),
                ),
              );
            }),
          ),
        ),
      ),
  };
});
