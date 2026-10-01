# Disposable cloud pilot — draft PR #2, never merge

This is throwaway experimental code. Upstream Orchestrator V2 is
[PR #2829](https://github.com/pingdotgg/t3code/pull/2829), verified open and unmerged
on 2026-10-01. A clean implementation and stacked PRs are separate future work,
only after that PR merges and Thomas asks again.

## Current state

The disabled production-path prototype is published on draft PR #2 after explicit
user approval. Live workflows have literal `false` gates and cannot run even when
secrets or repository variables exist. Secret-free CI validates this code; no live
Box execution, remote login, credential change or iPhone installation is implied.

The prototype runs a separate T3 server, using its existing authenticated Codex
provider, inside the existing dedicated Box. The Mac performs no build or agent
work. GitHub Actions builds/packages the runtime and runs the controller; a second,
independently dispatched workflow watches the deadline and confirms Box pause.
No workflow provisions a Box, creates credentials, enables public ingress, merges,
or installs an iPhone client.

## Explicit activation handoff — not authorized yet

Thomas personally enters secrets at
https://github.com/Githubguy132010/t3code/settings/secrets/actions/new :

- `T3_PILOT_BOX_API_KEY`: existing Box API credential. It is supplied only to
  controller/watchdog processes, never to the agent, repository, or console output.
- `T3_PILOT_REPO_TOKEN`: a fine-grained token restricted to the one approved test
  repository, with Contents and Pull requests write; Checks and Commit statuses
  read (plus GitHub's automatic Metadata read). No Actions or Workflows permission
  is needed on this token. It pushes a task branch and opens a **draft** PR so PR-only CI can
  run. It stays on the GitHub runner; Box exports a bounded Git bundle. No workflow
  file changes from that bundle are permitted. No token is created by this code.

The live workflow jobs also contain literal `false` gates. Removing these requires
a separately approved activation change and a new reviewed SHA; setting variables
alone cannot enable execution.

Repository Actions variables, to be set only after the activation approval:

- `T3_PILOT_ENABLED=true` (absent/false disables all live jobs)
- `T3_PILOT_APPROVED_HEAD=<exact reviewed and CI-green prototype SHA>`
- `T3_PILOT_BOX_ID=splendid-kite-93714`
- `T3_PILOT_APPROVED_REPOSITORY=Githubguy132010/persoonlijke-magister-addons`

`GH_TOKEN` is the Actions job token; the controller uses its Actions write
permission solely to dispatch the separate watchdog. The target-repository token
avoids relying on pushes by `GITHUB_TOKEN` to trigger CI automatically.

The runtime is built before any Box resume. One 30-minute budget starts before the
watchdog handshake and includes runtime transfer and a maximum eight-minute user
setup wait, so handshake delays consume rather than extend that budget. The remote T3 server
runs in setup-only mode until the selected Codex instance is installed, enabled
and authenticated. No task repository or agent runs during setup. A failed or
expired setup goes through scoped cancellation and confirmed pause.

These two already registered, manual-only workflow paths are overridden **only on
the prototype branch**, with explicit disposable names:

- `windows-tests.yml` (ID 357017170): controller/build, formerly Windows Tests.
- `mobile-showcase-screenshots.yml` (ID 315089437): independent watchdog.

Their original contents remain on `main`. The prototype versions use standard
Ubuntu runners; they do not run Windows/iOS builds. GitHub permits selecting the
prototype branch for an existing manual workflow. No default-branch change, merge,
new trigger or hidden live push trigger is needed. Choose the workflow by its
stable path/ID because GitHub's sidebar may retain the default-branch display name.

### User-only connection and sign-in, during the approved window

Use a computer with an SSH client and browser. This is not an iPhone connection
claim. Once Actions reports `awaiting-user-setup`, Thomas opens:

```sh
ssh -o ExitOnForwardFailure=yes -L 127.0.0.1:3773:127.0.0.1:3773 splendid-kite-93714@us-east-1.box.upstash.com
```

Enter the existing Box key only at SSH's password prompt. Verify the SSH host key
through the provider before accepting a new host; do not disable host-key checks.
In that remote shell, create a short-lived standard-client pairing credential:

```sh
node /workspace/home/t3-pilot/runtime/dist/bin.mjs auth pairing create --base-dir /workspace/home/t3-pilot/t3-home --base-url http://127.0.0.1:3773 --ttl 5m --label cloud-pilot
```

Open the resulting pairing URL locally, then Settings → Providers → Codex →
Sign in with ChatGPT. Installation happens on the Box. Thomas personally approves
the OAuth connection and **token sharing** (`chatgpt.tokens.use.direct`). This
managed provider does not use a generic device-code login or `t3 auth` for provider
login. If sign-in does not return, paste the final localhost redirect URL only in
T3's password-style “ChatGPT sign-in redirect URL” field and select Connect.
Neither the pairing URL nor OAuth redirect belongs in chat, Actions output or a
repository. Do not copy existing Mac credentials. Close the SSH session after
setup; do not reconnect after cleanup without approval, because Box requests can
wake paused compute. Port forwarding binds only local loopback and opens no public
Box endpoint, but authorized local processes can reach that local port.

ChatGPT access/refresh credentials persist under the remote T3 home in T3's
file-backed secret store (directory 0700, files 0600; not application-encrypted).
Tasks run as the same Box user and can read that user's files. Approval therefore
includes granting this dedicated Box/owned-repository experiment access to the
connected ChatGPT account. Pausing preserves credentials, runtime and task files;
it does not sign out or revoke OAuth. Revocation/removal is a separate explicit
user action. GitHub/Box API credentials remain outside the agent process.

One bundled **live** approval must specify: exact prototype SHA, existing Box,
remote Codex login and allowance, selected public repository/base branch/base SHA,
required check names, GitHub permissions above, selected approval mode, **$0 extra**
spend, freshly checked free compute/artifact-storage allowance, and one 30-minute
window. No paid API key, pay-as-you-go upgrade or new resource is implied. If the
free allowance cannot be verified, do not dispatch. The Box must already provide
Node >=24.10. The eight-minute setup check must confirm remote login before tasks.
For the documented Free small Box (two cores), reserve at least one remaining CPU
hour for a 30-minute window. The plan's five monthly CPU hours and built-in agent
token allowance do not fund external Codex usage; verify ChatGPT allowance too.
No target-repository token is created by this code. Pull requests write is needed
because the accepted task uses a new branch, not the branch already attached to PR1.

The later Magister task must use a separate task branch from draft PR1 at
`865bb2c417651b4b448af50d13109404cf7bfda4`, with its actual base branch and CI names
resolved immediately before activation. Preserve text, lesson identity, completed
status and tenant/student scope in JSON backup/export/restore. No Magister changes
have been made while preparing this prototype.

## Execution and evidence

Dispatch `windows-tests.yml` on the exact approved branch/head. Supply JSON
`repository`, `baseBranch`, `baseSha`, `providerInstanceId`, `instruction`, and unique
`requiredChecks`; choose `approval-required` or explicitly approve
`auto-accept-edits`. The worker stops with an `approval-required` receipt if it
receives an interactive request; it never silently switches to full access.

The watchdog must publish its ready artifact before the controller resumes Box.
Resume and uncertain shell mutations are never retried. Two agent attempts are
allowed; each turn is at most 10 minutes and obeys the remaining task deadline.
Box cleanup starts 150 seconds before the 30-minute deadline; three pause attempts
use 10-second total deadlines per HTTP operation. DNS delay and response trickling
are bounded for controller/watchdog API calls. Provider turn completion comes from
T3 events, not merely acknowledgement of `sendTurn()`.

Remote work admission closes at minute 25, including enough time for each admitted
HTTP request to finish before that point. The controller attempts graceful server
cancellation with exact process arguments and its unique task identifier, then
pauses. The watchdog only pauses; it never executes a command that could wake a
paused Box. If GitHub monitoring fails, it waits for its fixed pause point.
Interrupted HTTP requests are expired before cleanup. Forced process termination
can still leave provider cancellation unconfirmed: pause is a compute receipt,
not proof that an agent exited. Do not automatically resume an uncertain task.

Worker receipts live under `/workspace/home/t3-pilot/jobs/<id>/turn-<attempt>.json`.
Task and independently confirmed pause receipts are retained as Actions artifacts.
Reconnect/read these receipts after a client disconnect; do not rerun an ambiguous
job. Missing checks, mismatched SHAs and duplicate check names never count as green.
Cancel the controller workflow to request early stop; do **not** cancel its separate
watchdog. If pause remains unconfirmed, manually pause the selected Box in Upstash.
This is bounded best-effort cleanup, not a provider-enforced hard TTL or dollar cap.

The current web form remains readiness-only. The first real experiment is started
through the explicit Actions dispatch, not through an unimplemented UI button.
Native iPhone packaging and end-to-end paired-client acceptance are still separate.

Verified references:

- https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow
- https://upstash.com/docs/box/overall/shell
- https://upstash.com/docs/box/guides/openclaw-setup
- https://upstash.com/pricing/box
