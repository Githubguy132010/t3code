# Kilo

Local Kilo execution is disabled in this preview. T3 refuses every local process
start, including provider checks, new prompts, text generation and restored
sessions. CLI 7.8.3 can start MCP commands and connections before approval despite
pure mode, disabled project configuration and deny-all session permissions. Both
legacy project directories and global/profile sources are affected. The Kilo tool
sandbox does not cover MCP startup or reconnect.

No released runtime has a verified fix. Restoring local support requires an
explicitly supported dependency with a process-level MCP policy boundary, tested
across startup, prompts, configuration changes, reconnect and resume. A profile
scan or disabling known server names is insufficient. T3 does not alter your
configuration or patch the installed CLI. There is no unsafe-execution override.
Existing local history and account configuration are retained. The earlier local
prompt, approval, fork, rewind, subagent and text-generation tests are historical
conformance evidence, not currently available functionality. Local Kilo and cloud
parallel execution is consequently blocked. Restricted-mode subagents remain
disallowed even if local execution is restored.

| Capability                                              | Local Kilo                                     | Kilo Cloud                                                                           |
| ------------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------ |
| New prompts and follow-up                               | Blocked before process start                   | Full access only                                                                     |
| Concurrent isolated threads                             | Blocked                                        | Separate remote worktrees and task identities                                        |
| Local/cloud parallel tasks                              | Blocked                                        | Requires a safe local runtime                                                        |
| History and recovery                                    | Stored history retained; native resume blocked | Durable task identity, paginated admission recovery; no blind resubmit               |
| Stop                                                    | No local process starts                        | Requests inference interruption; sleep and compute observed separately               |
| Approvals and questions                                 | Blocked                                        | Handles interactions emitted by the remote runtime; cannot enforce restricted policy |
| Rewind, fork, local files, checkpoints, text generation | Blocked                                        | Not supported                                                                        |
| Subagents                                               | Blocked                                        | Remote Full access may execute them; child history not integrated                    |
| Web, desktop and mobile                                 | Shows execution-blocked status                 | Selection, account/model settings and task status; local workspace controls disabled |

For remote execution, add a separate **Kilo Cloud** instance in Settings > Providers.
Select a profile signed in through the official Kilo login, a GitHub repository that
account can access, its branch, and a model. Enable paid cloud execution only when
you want prompts and that repository sent to Kilo. T3 never uploads your local
checkout or uncommitted changes. Each cloud thread has its own remote worktree. Local Kilo concurrency awaits a
safe native runtime.

Cloud execution currently requires **Full access**. The deployed cloud runtime
does not apply custom agent permissions, so T3 refuses restricted and Plan modes
before submitting a paid task. Shell, edits and subagents cannot be restricted in
cloud Full access. Cloud subagent history is not integrated. Local Kilo is also unavailable while the runtime safety gate is in place. Inherited Kilo profiles with setup,
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

Admission recovery retains scan progress and follows customer API cursors. An
unresolved start remains uncertain and is not automatically submitted again.
If the remote API reports completion without the corresponding final reply,
T3 keeps the turn unresolved instead of inventing a successful result. This
recovery case still needs a verified terminal contract; inspect the task in Kilo.
A failed or interrupted task can finish even if its history is incomplete.
Reopening the thread can retry history retrieval.
