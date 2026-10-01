import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";
export function createCloudExecutionCommand<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  // Commands are transient; credentials must never be keys of cached query atoms.
  return createEnvironmentRpcCommand(runtime, {
    label: "cloud-execution",
    tag: WS_METHODS.cloudExecutionCommand,
  });
}
