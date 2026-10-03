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

Kilo Cloud Agents are not available in this preview. No cloud task is launched and
no repository is uploaded by selecting this provider.
