import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { threadLocalWorkspace } from "./threadLocalWorkspace";

describe("mobile thread workspace routing", () => {
  const local = {
    driver: ProviderDriverKind.make("codex"),
    providerThreads: [],
    activeProviderThreadId: null,
    worktreePath: "/local/worktree",
    workspaceRoot: "/local/repository",
  };
  it("keeps local worktree and repository actions available for a known local provider", () => {
    expect(threadLocalWorkspace(local)).toEqual({
      localWorkspaceEnabled: true,
      selectedThreadWorktreePath: "/local/worktree",
      selectedThreadCwd: "/local/worktree",
      selectedThreadGitRootCwd: "/local/repository",
    });
    expect(threadLocalWorkspace({ ...local, worktreePath: null }).selectedThreadCwd).toBe(
      "/local/repository",
    );
  });
  it("never supplies a local Git/file target for cloud, missing providers or persisted cloud history", () => {
    const persisted = [
      { id: "remote", nativeMetadata: { cloudExecution: { sessionId: "workspace_remote" } } },
    ] as unknown as OrchestrationV2ThreadProjection["providerThreads"];
    for (const input of [
      { ...local, driver: ProviderDriverKind.make("kilo-cloud") },
      { ...local, driver: undefined },
      { ...local, activeProviderThreadId: ProviderThreadId.make("not-loaded") },
      {
        ...local,
        activeProviderThreadId: ProviderThreadId.make("cloud-before-admission"),
        providerThreads: [
          { id: "cloud-before-admission", driver: "kilo-cloud" },
        ] as unknown as OrchestrationV2ThreadProjection["providerThreads"],
      },
      {
        ...local,
        providerThreads: persisted,
        activeProviderThreadId: ProviderThreadId.make("remote"),
      },
    ])
      expect(threadLocalWorkspace(input)).toEqual({
        localWorkspaceEnabled: false,
        selectedThreadWorktreePath: null,
        selectedThreadCwd: null,
        selectedThreadGitRootCwd: null,
      });
  });
});
