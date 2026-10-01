vi.mock("./settingsLayout", () => ({ SettingsSection: "section" }));
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness: h } = await import("../../test/reactHookHarness");
  return { ...actual, useRef: h.useRef, useState: h.useState };
});
vi.mock("react/compiler-runtime", async () => ({
  c: (await import("../../test/reactHookHarness")).reactHookHarness.useMemoCache,
}));
const request = vi.hoisted(() => vi.fn());
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => request }));
vi.mock("../../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("@t3tools/client-runtime/state/cloudExecution", () => ({
  createCloudExecutionCommand: () => ({}),
}));
import { CloudTaskSettings } from "./CloudTaskSettings";
function render() {
  hooks.beginRender();
  return CloudTaskSettings({ environmentId: EnvironmentId.make("cloud-test") });
}
function control(tree: ReturnType<typeof render>, label: string) {
  const e = visitElements(
    tree,
    (e) => e.props.children === label && typeof e.props.onClick === "function",
  );
  if (!e) throw new Error("Missing control");
  return e.props as { onClick: () => void; disabled: boolean };
}
function field(tree: ReturnType<typeof render>, label: string) {
  const e = visitElements(tree, (e) => e.props["aria-label"] === label);
  if (!e) throw new Error("Missing field");
  return e.props as {
    onChange: (e: { target: { value: string } }) => void;
    ref: { current: { value: string } | null };
    disabled: boolean;
  };
}
beforeEach(() => {
  hooks.reset();
  request.mockReset();
});
it("rejects incomplete task input before any RPC", () => {
  control(render(), "Check task readiness").onClick();
  expect(request).not.toHaveBeenCalled();
  expect(visitElements(render(), (e) => e.props.role === "alert")).toBeTruthy();
});
it("submits selected repository and task and displays fail-closed readiness", async () => {
  request.mockResolvedValue({ _tag: "Success", value: { task: {
    repository: "owner/repo", branch: "t3-cloud/test", stage: "blocked", attempt: 0,
    sha: null, blockers: ["Remote authorization required"], cleanupConfirmed: false,
  } } });
  for (const [label, value] of [
    ["GitHub repository", "owner/repo"], ["Starting commit SHA", "a".repeat(40)],
    ["Provider instance ID", "codex"], ["Cloud task instruction", "Fix the test"],
    ["Required CI checks", "unit, build"],
  ] as const) field(render(), label).onChange({ target: { value } });
  control(render(), "Check task readiness").onClick();
  expect(request.mock.calls[0]?.[0].input).toEqual({ action: "task-submit", spec: {
    repository: "owner/repo", baseSha: "a".repeat(40), providerInstanceId: "codex",
    instruction: "Fix the test", requiredChecks: ["unit", "build"],
  } });
  await request.mock.results[0]!.value;
  await Promise.resolve();
  expect(visitElements(render(), (e) => e.props.children === "Remote authorization required")).toBeTruthy();
  expect(control(render(), "Clear task").disabled).toBe(false);
});
