import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { KiloCloudError } from "./KiloCloudClient.ts";

const Auth = Schema.Struct({
  kilo: Schema.Union([
    Schema.Struct({ type: Schema.Literal("oauth"), access: Schema.NonEmptyString }),
    Schema.Struct({ type: Schema.Literal("api"), key: Schema.NonEmptyString }),
  ]),
});
const Profile = Schema.Struct({
  user: Schema.Struct({ id: Schema.NonEmptyString }),
  hasPersonalAccount: Schema.Boolean,
});

const decodeAuth = Schema.decodeUnknownEffect(Schema.fromJsonString(Auth));
const decodeProfile = Schema.decodeUnknownEffect(Profile);

/** Reads only the selected official CLI profile. Login and token refresh remain Kilo's job. */
export const make = Effect.fn("KiloCloudAccount.make")(function* (profileDirectory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let cached: { token: Redacted.Redacted<string>; accountId: string } | undefined;
  const load = Effect.gen(function* () {
    const saved = yield* decodeAuth(
      yield* fs.readFileString(path.join(profileDirectory, "data", "kilo", "auth.json")),
    );
    const token = saved.kilo.type === "oauth" ? saved.kilo.access : saved.kilo.key;
    if (cached && Redacted.value(cached.token) === token) return cached;
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.get("https://app.kilo.ai/api/profile", {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    if (response.status !== 200)
      return yield* new KiloCloudError({ operation: "authentication", reason: "rejected" });
    const profile = yield* decodeProfile(yield* response.json);
    if (!profile.hasPersonalAccount)
      return yield* new KiloCloudError({ operation: "personal-account", reason: "unsupported" });
    cached = { accountId: profile.user.id, token: Redacted.make(token) };
    return cached;
  }).pipe(
    Effect.scoped,
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
    Effect.provide(FetchHttpClient.layer),
    Effect.timeout("15 seconds"),
    Effect.mapError(() => new KiloCloudError({ operation: "authentication", reason: "rejected" })),
  );
  return { load };
});
