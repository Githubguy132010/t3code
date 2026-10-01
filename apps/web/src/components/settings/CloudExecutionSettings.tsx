import { useRef, useState } from "react";
import type {
  CloudExecutionCommand,
  CloudExecutionSnapshot,
  EnvironmentId,
} from "@t3tools/contracts";
import { createCloudExecutionCommand } from "@t3tools/client-runtime/state/cloudExecution";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsSection } from "./settingsLayout";
const cloudCommand = createCloudExecutionCommand(connectionAtomRuntime);
export function CloudExecutionSettings({ environmentId }: { environmentId: EnvironmentId }) {
  const keyField = useRef<HTMLInputElement>(null);
  const [boxId, setBoxId] = useState("");
  const [snapshot, setSnapshot] = useState<CloudExecutionSnapshot | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useAtomCommand(cloudCommand, { reportFailure: false, reportDefect: false });
  async function execute(input: CloudExecutionCommand) {
    setPending(true);
    setError(null);
    try {
      const result = await run({ environmentId, input });
      if (result._tag !== "Success") {
        setError("Action unconfirmed. Check the selected Box in Upstash.");
        return;
      }
      setSnapshot({
        boxId: result.value.boxId,
        phase: result.value.phase,
        deadline: result.value.deadline,
        pauseAttempts: result.value.pauseAttempts,
      });
      if (result.value.export) {
        const url = URL.createObjectURL(
          new Blob([result.value.export.patch], { type: "text/plain" }),
        );
        const link = document.createElement("a");
        link.href = url;
        link.download = boxId + ".patch";
        link.click();
        URL.revokeObjectURL(url);
      }
    } finally {
      setPending(false);
    }
  }
  return (
    <SettingsSection title="Upstash Box pilot" id="upstash-box-pilot">
      <p>
        Select an existing paused Free Box. Verify at least one free CPU-hour remains before
        resuming. No Box is created here.
      </p>
      <div className="flex flex-col gap-3">
        <Input
          aria-label="Box ID"
          value={boxId}
          onChange={(event) => setBoxId(event.target.value)}
          disabled={pending || (snapshot !== null && snapshot.phase !== "unconfigured")}
        />
        <Input
          nativeInput
          ref={keyField}
          aria-label="Box API key"
          type="password"
          autoComplete="off"
          disabled={pending || (snapshot !== null && snapshot.phase !== "unconfigured")}
        />
        <Button
          disabled={pending || (snapshot !== null && snapshot.phase !== "unconfigured") || !boxId}
          onClick={() => {
            const apiKey = keyField.current?.value ?? "";
            if (keyField.current) keyField.current.value = "";
            void execute({ action: "attach", boxId, apiKey });
          }}
        >
          Connect selected Box
        </Button>
        <p>
          Key stays in this T3 server's memory until pause or shutdown. Cleanup starts after 27½
          minutes to reserve time for three attempts. No automatic recovery after server failure.
          Use the Upstash console if pause is unconfirmed.
        </p>
        <Button
          disabled={pending || snapshot?.phase !== "ready"}
          onClick={() => {
            if (
              window.confirm(
                "Resume this verified Free Box for up to 30 minutes? Reserve one free CPU-hour; additional spend must remain $0.",
              )
            ) {
              void execute({
                action: "resume",
                confirmedFree: true,
                maxExtraUsd: 0,
                durationSeconds: 1800,
              });
            }
          }}
        >
          Resume for 30 minutes
        </Button>
        <Button
          disabled={pending || snapshot?.phase !== "running"}
          onClick={() => void execute({ action: "export" })}
        >
          Export prepared patch
        </Button>
        <Button
          disabled={pending || !snapshot || snapshot.phase === "paused"}
          onClick={() => void execute({ action: "pause" })}
        >
          Pause Box
        </Button>
        <Button disabled={pending} onClick={() => void execute({ action: "status" })}>
          Refresh status
        </Button>
        <p>
          This pilot manages compute and exports. Repository tasks and agent execution are not
          connected yet.
        </p>
        {snapshot && (
          <p role="status">
            {snapshot.boxId}: {snapshot.phase}
            {snapshot.deadline
              ? " — deadline " + new Date(snapshot.deadline).toLocaleTimeString()
              : ""}
          </p>
        )}
        {error && <p role="alert">{error}</p>}
      </div>
    </SettingsSection>
  );
}
