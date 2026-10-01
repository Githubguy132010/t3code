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
  repository, with Contents and Pull requests write; Actions, Checks and Commit
  statuses read. It pushes a task branch and opens a **draft** PR so PR-only CI can
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

Before execution, a separate supervised setup must install the CI-built runtime
in `/workspace/home/t3-pilot/runtime`, use Node >=24.10, and configure/sign in the
Codex instance in the **remote** T3 home `/workspace/home/t3-pilot/t3-home` through
T3's existing provider setup. Do not copy Mac credentials. No provider login CLI
is invented here: T3's `auth` CLI handles T3 pairing/sessions, not provider login.
The authenticated remote UI/SSH pairing path must be verified during this setup;
public ingress is not enabled by this prototype. Pause and verify the Box afterward.

GitHub requires a registered/default-branch workflow for manual dispatch. These
new workflows are on an unmerged draft; registration must be verified before live
activation. If GitHub requires adding the two workflow files to the fork's default
branch, obtain separate permission for that narrow bootstrap change. Do not merge
PR #2 or change the default branch as a workaround.

One bundled **live** approval must specify: exact prototype SHA, existing Box,
remote Codex login and allowance, selected public repository/base branch/base SHA,
required check names, GitHub permissions above, selected approval mode, **$0 extra**
spend, freshly checked free compute/artifact-storage allowance, and one 30-minute
window. No paid API key, pay-as-you-go upgrade or new resource is implied. If the
free allowance or remote login cannot be verified, do not dispatch.

The later Magister task must use a separate task branch from draft PR1 at
`865bb2c417651b4b448af50d13109404cf7bfda4`, with its actual base branch and CI names
resolved immediately before activation. Preserve text, lesson identity, completed
status and tenant/student scope in JSON backup/export/restore. No Magister changes
have been made while preparing this prototype.

## Execution and evidence

Dispatch `cloud-pilot-execute.yml` on the exact approved branch/head. Supply JSON
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
