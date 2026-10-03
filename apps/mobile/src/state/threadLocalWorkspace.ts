import type { OrchestrationV2ThreadProjection, ProviderDriverKind } from "@t3tools/contracts";

/** Never substitute a local checkout for a remote or unresolved conversation. */
export function threadLocalWorkspace(input: {
  readonly driver: ProviderDriverKind | undefined;
  readonly providerThreads: OrchestrationV2ThreadProjection["providerThreads"];
  readonly activeProviderThreadId: OrchestrationV2ThreadProjection["thread"]["activeProviderThreadId"];
  readonly worktreePath: string | null;
  readonly workspaceRoot: string | null;
}) {
  const active = input.providerThreads.find((thread) => thread.id === input.activeProviderThreadId);
  const cloud =
    input.driver === "kilo-cloud" ||
    active?.driver === "kilo-cloud" ||
    !!active?.nativeMetadata?.cloudExecution;
  const resolved = input.activeProviderThreadId === null || active !== undefined;
  const enabled = resolved && !cloud && input.driver !== undefined;
  return {
    localWorkspaceEnabled: enabled,
    selectedThreadWorktreePath: enabled ? input.worktreePath : null,
    selectedThreadCwd: enabled ? (input.worktreePath ?? input.workspaceRoot) : null,
    selectedThreadGitRootCwd: enabled ? input.workspaceRoot : null,
  };
}
