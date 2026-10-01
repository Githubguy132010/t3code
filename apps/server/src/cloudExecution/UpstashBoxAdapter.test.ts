vi.mock("node:timers", () => ({
  setTimeout: (...args: Parameters<typeof setTimeout>) => setTimeout(...args),
  clearTimeout: (...args: Parameters<typeof clearTimeout>) => clearTimeout(...args),
}));
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { UpstashBoxSession } from "./UpstashBoxAdapter.ts";
const key = "dummy-pilot-only";
const attach = { action: "attach" as const, boxId: "selected-box", apiKey: key };
const resume = {
  action: "resume" as const,
  confirmedFree: true as const,
  maxExtraUsd: 0 as const,
  durationSeconds: 1800 as const,
};
const sessions: UpstashBoxSession[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const s of sessions.splice(0)) await s.dispose();
});
function fixture() {
  let status = "paused";
  const calls: { url: string; method: string }[] = [];
  const request: typeof fetch = async (url, options) => {
    const path = String(url);
    calls.push({ url: path, method: options?.method ?? "GET" });
    expect(new Headers(options?.headers).get("X-Box-Api-Key")).toBe(key);
    if (path.endsWith("/resume")) status = "idle";
    if (path.endsWith("/pause")) status = "paused";
    return Response.json(
      path.includes("/files/read")
        ? { content: Buffer.from("diff --git a/a b/a\n").toString("base64") }
        : { status },
    );
  };
  const s = new UpstashBoxSession(request);
  sessions.push(s);
  return { s, calls };
}
describe("Upstash selected Box lifecycle", () => {
  it("attaches without waking; resumes once; exports before confirmed pause", async () => {
    const { s, calls } = fixture();
    expect((await s.execute(attach)).phase).toBe("ready");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
    expect((await s.execute(resume)).phase).toBe("running");
    await expect(s.execute(resume)).rejects.toThrow();
    const result = await s.execute({ action: "export" });
    expect(result.export?.bytes).toBe(19);
    expect(result.export?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect((await s.execute({ action: "pause" })).phase).toBe("paused");
    await expect(s.execute({ action: "export" })).rejects.toThrow();
    expect(
      calls.every((c) =>
        c.url.startsWith("https://us-east-1.box.upstash.com/v2/box/selected-box/"),
      ),
    ).toBe(true);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    expect(JSON.stringify(s.snapshot())).not.toContain(key);
  });
  it("rejects attaching to an active Box", async () => {
    const s = new UpstashBoxSession(async () => Response.json({ status: "running" }));
    sessions.push(s);
    await expect(s.execute(attach)).rejects.toThrow();
    expect(s.snapshot().phase).toBe("unconfigured");
    await expect(s.execute(resume)).rejects.toThrow();
  });
  it("bounds manual pause retries and never exports after uncertain pause", async () => {
    let first = true;
    const s = new UpstashBoxSession(async () => {
      if (first) {
        first = false;
        return Response.json({ status: "paused" });
      }
      return new Response(key, { status: 500 });
    });
    sessions.push(s);
    await s.execute(attach);
    for (let n = 0; n < 4; n++)
      await expect(s.execute({ action: "pause" })).rejects.not.toThrow(key);
    expect(s.snapshot().pauseAttempts).toBe(3);
    await expect(s.execute({ action: "export" })).rejects.toThrow();
  });
  it("automatically requests and verifies pause at its deadline", async () => {
    vi.useFakeTimers();
    const { s } = fixture();
    await s.execute(attach);
    await s.execute(resume);
    await vi.advanceTimersByTimeAsync(1800_000);
    expect((await s.execute({ action: "status" })).phase).toBe("paused");
  });
  it("rejects credential-bearing export data", async () => {
    let status = "paused";
    const s = new UpstashBoxSession(async (url) => {
      const p = String(url);
      if (p.endsWith("/resume")) status = "idle";
      if (p.endsWith("/pause")) status = "paused";
      return Response.json(
        p.includes("/files/read") ? { content: Buffer.from(key).toString("base64") } : { status },
      );
    });
    sessions.push(s);
    await s.execute(attach);
    await s.execute(resume);
    await expect(s.execute({ action: "export" })).rejects.toThrow();
  });
});

it("retries deadline cleanup and exposes exhausted cleanup", async () => {
  vi.useFakeTimers();
  let active = false;
  let attempts = 0;
  const s = new UpstashBoxSession(async (url) => {
    const path = String(url);
    if (path.endsWith("/resume")) active = true;
    if (path.endsWith("/pause")) {
      attempts++;
      return new Response(null, { status: 503 });
    }
    return Response.json({ status: active ? "running" : "paused" });
  });
  sessions.push(s);
  await s.execute(attach);
  await s.execute(resume);
  await vi.advanceTimersByTimeAsync(1650_000);
  expect(attempts).toBe(3);
  expect(s.snapshot().phase).toBe("cleanup-failed");
  await expect(s.execute({ action: "pause" })).rejects.toThrow();
  expect(attempts).toBe(3);
  // Avoid hiding the expected dispose error in teardown.
  sessions.splice(sessions.indexOf(s), 1);
  await expect(s.dispose()).rejects.toThrow();
});

it("retries a transient deadline failure and confirms provider pause", async () => {
  vi.useFakeTimers();
  let status = "paused";
  let attempts = 0;
  const s = new UpstashBoxSession(async (url) => {
    const path = String(url);
    if (path.endsWith("/resume")) status = "running";
    if (path.endsWith("/pause")) {
      if (++attempts === 1) return new Response(null, { status: 503 });
      status = "paused";
    }
    return Response.json({ status });
  });
  sessions.push(s);
  await s.execute(attach);
  await s.execute(resume);
  await vi.advanceTimersByTimeAsync(1650_000);
  expect(attempts).toBe(2);
  expect(s.snapshot().phase).toBe("paused");
});

it("does not queue exports ahead of cleanup and aborts the in-flight read", async () => {
  let status = "paused";
  let aborted = false;
  const s = new UpstashBoxSession(async (url, init) => {
    const path = String(url);
    if (path.endsWith("/resume")) status = "running";
    if (path.endsWith("/pause")) status = "paused";
    if (path.includes("/files/read")) {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("Aborted"));
        });
      });
    }
    return Response.json({ status });
  });
  sessions.push(s);
  await s.execute(attach);
  await s.execute(resume);
  const pending = s.execute({ action: "export" });
  const rejected = expect(pending).rejects.toThrow();
  await expect(s.execute({ action: "export" })).rejects.toThrow();
  expect((await s.execute({ action: "pause" })).phase).toBe("paused");
  await rejected;
  expect(aborted).toBe(true);
});

it("refreshes provider status and permits retry after failed attachment", async () => {
  let status = "running";
  const s = new UpstashBoxSession(async () => Response.json({ status }));
  sessions.push(s);
  await expect(s.execute(attach)).rejects.toThrow();
  status = "paused";
  await s.execute(attach);
  status = "running";
  expect((await s.execute({ action: "status" })).phase).toBe("error");
  status = "paused";
  expect((await s.execute({ action: "status" })).phase).toBe("ready");
});
