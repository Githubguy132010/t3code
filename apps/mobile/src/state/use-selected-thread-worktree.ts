import * as Option from "effect/Option";
import { useMemo } from "react";

import { useSelectedThreadWorktreePath, useSelectedThreadDetailState } from "./use-thread-detail";
import { useThreadSelection } from "./use-thread-selection";
import { resolvePreferredThreadWorktreePath } from "../features/terminal/terminalLaunchContext";

import { threadLocalWorkspace } from "./threadLocalWorkspace";

export function useSelectedThreadWorktree() {
  const { selectedThread, selectedThreadProject, selectedEnvironmentRuntime } =
    useThreadSelection();
  const projection = Option.getOrNull(useSelectedThreadDetailState().data);
  const detailWorktreePath = useSelectedThreadWorktreePath();

  const selectedThreadWorktreePath = useMemo(
    () =>
      resolvePreferredThreadWorktreePath({
        threadShellWorktreePath: selectedThread?.worktreePath ?? null,
        threadDetailWorktreePath: detailWorktreePath,
      }),
    [detailWorktreePath, selectedThread?.worktreePath],
  );

  return threadLocalWorkspace({
    driver: selectedEnvironmentRuntime?.serverConfig?.providers.find(
      (provider) => provider.instanceId === selectedThread?.providerInstanceId,
    )?.driver,
    providerThreads: projection?.providerThreads ?? [],
    activeProviderThreadId: selectedThread?.activeProviderThreadId ?? null,
    worktreePath: selectedThreadWorktreePath,
    workspaceRoot: selectedThreadProject?.workspaceRoot ?? null,
  });
}
