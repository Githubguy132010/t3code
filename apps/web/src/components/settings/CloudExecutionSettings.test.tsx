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
import { CloudExecutionSettings } from "./CloudExecutionSettings";
function render() {
  hooks.beginRender();
  return CloudExecutionSettings({ environmentId: EnvironmentId.make("cloud-test") });
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
it("clears the credential field before the asynchronous request resolves", async () => {
  let finish!: (value: unknown) => void;
  request.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  field(render(), "Box ID").onChange({ target: { value: "selected-box" } });
  const tree = render();
  const key = field(tree, "Box API key");
  key.ref.current = { value: "dummy-pilot-only" };
  control(tree, "Connect selected Box").onClick();
  expect(key.ref.current.value).toBe("");
  expect(control(render(), "Connect selected Box").disabled).toBe(true);
  expect(request.mock.calls[0]?.[0].input).toEqual({
    action: "attach",
    boxId: "selected-box",
    apiKey: "dummy-pilot-only",
  });
  finish({
    _tag: "Success",
    value: { boxId: "selected-box", phase: "ready", deadline: null, pauseAttempts: 0 },
  });
  await request.mock.results[0]!.value;
  await Promise.resolve();
  expect(control(render(), "Resume for 30 minutes").disabled).toBe(false);
});
it("does not resume when the user declines the time and budget confirmation", async () => {
  request.mockResolvedValue({
    _tag: "Success",
    value: { boxId: "selected-box", phase: "ready", deadline: null, pauseAttempts: 0 },
  });
  control(render(), "Refresh status").onClick();
  await request.mock.results[0]!.value;
  await Promise.resolve();
  const confirm = vi.fn(() => false);
  vi.stubGlobal("window", { confirm });
  control(render(), "Resume for 30 minutes").onClick();
  expect(confirm).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledTimes(1);
  vi.unstubAllGlobals();
});
