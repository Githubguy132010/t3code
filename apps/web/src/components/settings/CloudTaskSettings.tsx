import { useState } from "react";
import * as Schema from "effect/Schema";
import { CloudTaskSpec, type CloudTaskSnapshot, type EnvironmentId } from "@t3tools/contracts";
import { createCloudExecutionCommand } from "@t3tools/client-runtime/state/cloudExecution";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsSection } from "./settingsLayout";
const command = createCloudExecutionCommand(connectionAtomRuntime);
const isTask = Schema.is(CloudTaskSpec);
export function CloudTaskSettings({ environmentId }: { environmentId: EnvironmentId }) {
  const [repository, setRepository] = useState("");
  const [baseSha, setBaseSha] = useState("");
  const [providerInstanceId, setProvider] = useState("");
  const [instruction, setInstruction] = useState("");
  const [checks, setChecks] = useState("");
  const [task, setTask] = useState<CloudTaskSnapshot | undefined>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useAtomCommand(command, { reportFailure: false, reportDefect: false });
  async function submit(clear = false) {
    const spec: unknown = { repository, baseSha, providerInstanceId, instruction, requiredChecks: checks.split(",").map((name) => name.trim()).filter(Boolean) };
    if (!clear && !isTask(spec)) {
      setError("Enter owner/repository, a full commit SHA, a provider instance ID, a task and required CI check names.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result = await run({ environmentId, input: clear ? { action: "task-clear" } : { action: "task-submit", spec: spec as CloudTaskSpec } });
      if (result._tag === "Success") setTask(result.value.task);
      else setError("Task readiness could not be checked.");
    } finally { setPending(false); }
  }
  return <SettingsSection title="Cloud repository task" id="cloud-repository-task">
    <p>Choose the repository, starting commit and configured provider instance. This pilot checks readiness; it does not start an agent until remote execution is connected and authorized.</p>
    <div className="flex flex-col gap-3">
      <Input aria-label="GitHub repository" placeholder="owner/repository" value={repository} onChange={(e) => setRepository(e.target.value)} disabled={pending} />
      <Input aria-label="Starting commit SHA" value={baseSha} onChange={(e) => setBaseSha(e.target.value)} disabled={pending} />
      <Input aria-label="Provider instance ID" value={providerInstanceId} onChange={(e) => setProvider(e.target.value)} disabled={pending} />
      <Input aria-label="Cloud task instruction" value={instruction} onChange={(e) => setInstruction(e.target.value)} disabled={pending} />
      <Input aria-label="Required CI checks" placeholder="unit, build" value={checks} onChange={(e) => setChecks(e.target.value)} disabled={pending} />
      <Button disabled={pending} onClick={() => void submit()}>Check task readiness</Button>
      <Button disabled={pending || !task} onClick={() => void submit(true)}>Clear task</Button>
      <p>Limit: two agent attempts, 20 minutes of work, $0 additional spend. Required checks must pass for the exact pushed commit. No merge is performed.</p>
      {task && <div role="status"><p>{task.repository}: {task.stage}</p><ul>{task.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul></div>}
      {error && <p role="alert">{error}</p>}
    </div>
  </SettingsSection>;
}
