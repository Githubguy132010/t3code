import * as NodeTimers from "node:timers";
import * as NodeCrypto from "node:crypto";
import type { CloudExecutionCommand, CloudExecutionSnapshot } from "@t3tools/contracts";
const BASE = "https://us-east-1.box.upstash.com";
const MAX_BYTES = 1024 * 1024;
const failure = () =>
  new Error("Cloud action failed or is unconfirmed. Check the selected Box in Upstash.");
export class UpstashBoxSession {
  #key: string | undefined;
  #boxId: string | null = null;
  #phase: CloudExecutionSnapshot["phase"] = "unconfigured";
  #deadline: number | null = null;
  #pauseAttempts = 0;
  #resumeAttempted = false;
  #timer: ReturnType<typeof NodeTimers.setTimeout> | undefined;
  #active: Promise<CloudExecutionSnapshot> | undefined;
  #cleanup: Promise<CloudExecutionSnapshot> | undefined;
  #closing = false;
  #abort: AbortController | undefined;
  private readonly request: typeof fetch;
  private readonly now: () => number;
  constructor(request: typeof fetch = fetch, now: () => number = Date.now) {
    this.request = request;
    this.now = now;
  }
  snapshot(): CloudExecutionSnapshot {
    return {
      boxId: this.#boxId,
      phase: this.#phase,
      deadline: this.#deadline,
      pauseAttempts: this.#pauseAttempts,
    };
  }
  execute(command: CloudExecutionCommand): Promise<CloudExecutionSnapshot> {
    if (command.action === "pause") return this.#pause();
    if (this.#active || this.#cleanup) return Promise.reject(failure());
    if (this.#closing && command.action !== "status") return Promise.reject(failure());
    const next = this.#execute(command).finally(() => {
      this.#active = undefined;
    });
    this.#active = next;
    return next;
  }
  async #pause(): Promise<CloudExecutionSnapshot> {
    if (this.#phase === "paused") return this.snapshot();
    if (this.#cleanup) return this.#cleanup;
    this.#closing = true;
    this.#abort?.abort();
    this.#phase = "pausing";
    this.#cleanup = (async () => {
      await this.#active?.catch(() => undefined);
      while (this.#key && this.#pauseAttempts < 3) {
        this.#pauseAttempts++;
        try {
          // Reconcile first: a previous timed-out POST may already have paused the Box.
          if ((await this.#http("GET", "/status")).status !== "paused") {
            await this.#http("POST", "/pause");
            if ((await this.#http("GET", "/status")).status !== "paused") throw failure();
          }
          this.#phase = "paused";
          this.#key = undefined;
          NodeTimers.clearTimeout(this.#timer);
          return this.snapshot();
        } catch {
          // The total attempt budget applies equally to manual and deadline cleanup.
        }
      }
      this.#phase = "cleanup-failed";
      throw failure();
    })();
    try {
      return await this.#cleanup;
    } finally {
      this.#cleanup = undefined;
    }
  }
  async #http(method: "GET" | "POST", path: string): Promise<Record<string, unknown>> {
    if (!this.#key || !this.#boxId) throw failure();
    const abort = new AbortController();
    this.#abort = abort;
    try {
      const response = await this.request(BASE + "/v2/box/" + this.#boxId + path, {
        method,
        redirect: "error",
        signal: AbortSignal.any([AbortSignal.timeout(15_000), abort.signal]),
        headers: { "X-Box-Api-Key": this.#key },
      });
      if (!response.ok) throw failure();
      if (!response.body) return {};
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 2 * MAX_BYTES) throw failure();
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel();
      }
      const text = Buffer.concat(chunks).toString("utf8");
      const value: unknown = text ? JSON.parse(text) : {};
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw failure();
      return value as Record<string, unknown>;
    } catch {
      throw failure();
    } finally {
      if (this.#abort === abort) this.#abort = undefined;
    }
  }
  async #execute(command: CloudExecutionCommand): Promise<CloudExecutionSnapshot> {
    if (command.action === "status") {
      if (!this.#key) return this.snapshot();
      const status = (await this.#http("GET", "/status")).status;
      if (status === "paused") {
        if (this.#resumeAttempted || this.#closing) {
          this.#phase = "paused";
          this.#key = undefined;
          NodeTimers.clearTimeout(this.#timer);
        } else this.#phase = "ready";
      } else if (status === "idle" || status === "running") {
        if (!this.#resumeAttempted) {
          this.#phase = "error";
        } else if (!this.#closing) this.#phase = "running";
      } else this.#phase = this.#closing ? "cleanup-failed" : "error";
      return this.snapshot();
    }
    if (command.action === "attach") {
      if (
        this.#phase !== "unconfigured" ||
        !/^[a-zA-Z0-9_-]{1,100}$/.test(command.boxId) ||
        !/^[\x21-\x7e]{8,512}$/.test(command.apiKey)
      )
        throw failure();
      this.#key = command.apiKey;
      this.#boxId = command.boxId;
      try {
        if ((await this.#http("GET", "/status")).status !== "paused") throw failure();
        this.#phase = "ready";
      } catch {
        this.#key = undefined;
        this.#phase = "unconfigured";
        this.#boxId = null;
        throw failure();
      }
    } else if (command.action === "resume") {
      if (
        this.#phase !== "ready" ||
        this.#resumeAttempted ||
        command.confirmedFree !== true ||
        command.maxExtraUsd !== 0 ||
        command.durationSeconds !== 1800
      )
        throw failure();
      this.#resumeAttempted = true;
      this.#phase = "resuming";
      this.#deadline = this.now() + 1800_000;
      // Reserve 150 seconds for up to three 45-second cleanup attempts.
      // Starts before the request, including an uncertain resume outcome.
      this.#timer = NodeTimers.setTimeout(() => {
        void this.execute({ action: "pause" }).catch(() => undefined);
      }, 1650_000);
      this.#timer.unref();
      try {
        await this.#http("POST", "/resume");
        const status = (await this.#http("GET", "/status")).status;
        if (status !== "idle" && status !== "running") throw failure();
        this.#phase = "running";
      } catch {
        if (!this.#closing) this.#phase = "error";
        throw failure();
      }
    } else if (command.action === "export") {
      if (
        this.#phase !== "running" ||
        (this.#deadline !== null && this.now() >= this.#deadline - 150_000)
      )
        throw failure();
      const result = await this.#http(
        "GET",
        "/files/read?path=%2Fworkspace%2Fhome%2Ft3-cloud-pilot.patch&encoding=base64&offset=0&length=1048577",
      );
      if (
        typeof result.content !== "string" ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(result.content)
      )
        throw failure();
      const payload = Buffer.from(result.content, "base64");
      if (
        !payload.length ||
        payload.length > MAX_BYTES ||
        (this.#key && payload.includes(this.#key))
      )
        throw failure();
      if (this.#closing) throw failure();
      const patch = new TextDecoder("utf-8", { fatal: true }).decode(payload);
      return {
        ...this.snapshot(),
        export: {
          patch,
          bytes: payload.length,
          sha256: NodeCrypto.createHash("sha256").update(payload).digest("hex"),
        },
      };
    }
    return this.snapshot();
  }
  async dispose(): Promise<void> {
    try {
      if (this.#resumeAttempted && this.#phase !== "paused")
        await this.execute({ action: "pause" });
    } finally {
      NodeTimers.clearTimeout(this.#timer);
      this.#key = undefined;
    }
  }
}
