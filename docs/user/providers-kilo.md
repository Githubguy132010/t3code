# Kilo

The native Kilo provider is a preview. Install Kilo CLI **7.8.3** on the machine
running the T3 environment, then add Kilo in **Settings > Providers**. Set the
binary path if `kilo` is not on that machine's PATH. Other CLI versions are
rejected because their protocol has not been verified with this provider.

Each provider instance has a separate account profile. T3 does not copy credentials
from your ordinary Kilo installation. You can supply an existing `KILO_API_KEY`
in the instance's environment settings or select an existing profile directory.
That directory must contain the `config`, `data`, `cache`, and `state` directories
used as Kilo's XDG roots. It is not the directory containing `auth.json` alone.

Use a separate instance and profile for each account. Changing the account profile
or instance environment retires its running processes. Existing threads cannot
resume under the replacement account. A Ready status confirms local CLI readiness;
it does not prove that a model account is authenticated or has available credit.

Local processes use a fixed credential snapshot. Replacing credentials in the same
profile retires its processes and prevents old threads from resuming after reload.
Reload the provider after login or token refresh and start a new thread. Credential
refresh is conservatively treated as an account change because local account
identity cannot be verified without contacting each model provider.

Prompts run in the selected T3 workspace. Use separate T3 worktrees for tasks that
must not share files. Separate conversation IDs alone do not isolate a checkout.
Stop terminates the task's owned local process group. A later prompt can restore
its saved conversation in a new process. Rewind copies the retained native
conversation and lets T3 restore the selected file checkpoint.

Subagents require Full access with no additional approval or sandbox restrictions.
Kilo's own configured child approvals still apply. Restricted modes and Plan mode
block subagent creation because Kilo 7.8.3 does not propagate T3's approval rules
to children. Background subagents and independent child cancellation are not
supported. Tool results appear when the tool finishes; live tool output is not
advertised.

You can select models and control tasks from web, desktop, and mobile clients
connected to the environment. Configure account profiles in web or desktop
settings. A disconnected client does not stop its task.

For remote execution, add a separate **Kilo Cloud** instance in Settings > Providers.
Select a profile signed in through the official Kilo login, a GitHub repository that
account can access, its branch, and a model. Enable paid cloud execution only when
you want prompts and that repository sent to Kilo. T3 never uploads your local
checkout or uncommitted changes. Local Kilo and Kilo Cloud can run concurrently in
separate threads; each cloud thread has its own remote worktree.

Cloud execution currently requires **Full access**. The deployed cloud runtime
does not apply custom agent permissions, so T3 refuses restricted and Plan modes
before submitting a paid task. Shell, edits and subagents cannot be restricted in
cloud Full access. Cloud subagent history is not integrated. Use local Kilo when
you need approvals or restricted execution. Inherited Kilo profiles with setup,
MCP, skills, agents or environment variables are rejected before a new cloud task.

Cloud prompts, native history and follow-up messages use the same remote session.
T3 reconnects by its saved task identity and does not automatically resend an
uncertain start. A cloud thread cannot use local attachments, terminals, file
checkpoints, rewind, forks or background text generation. Switching accounts does
not transfer existing tasks or stop them.

Cloud tasks spend Kilo credit for inference and sandbox use. Automatic commits are
disabled, but an agent in Full access can still modify the remote checkout. Stop
requests inference interruption; closing a stream, task completion and sandbox
sleep are separate events. The thread shows task, sandbox and compute status
separately. Compute estimates can cover a shared account sandbox and are not a
per-task invoice. Unknown or settling status does not mean billing has stopped.
T3 does not top up credit or force a sandbox to sleep.
