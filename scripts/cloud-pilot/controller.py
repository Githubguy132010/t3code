"""Disposable PR #2 controller. No provisioning, credential creation or log forwarding.

Box REST contracts pinned to upstash/box a4ac7730a110586b760c4e3de849809e7bae8602.
Only an explicitly approved workflow may call main(); imports and tests do no I/O.
"""
import base64
import http.client
import socket
import threading
import json
import os
from pathlib import Path
import re
import shlex
import signal
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

BASE = "https://us-east-1.box.upstash.com/v2/box/"
ROOT = "/workspace/home/t3-pilot"
WATCHDOG_WORKFLOW = "mobile-showcase-screenshots.yml"
SHA = re.compile(r"[a-f0-9]{40}")


class PilotError(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request(url, token, method="GET", body=None, box=False, timeout=20):
    headers = {"Accept": "application/vnd.github+json", "Content-Type": "application/json"}
    headers["X-Box-Api-Key" if box else "Authorization"] = token if box else "Bearer " + token
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != "https": raise PilotError("HTTPS required")
    done, expired = threading.Event(), threading.Event()
    result = []
    connection = http.client.HTTPSConnection(parsed.hostname, parsed.port, timeout=timeout)
    wire = [None]
    def abort():
        expired.set()
        sock = wire[0] or connection.sock
        if sock:
            try: sock.shutdown(socket.SHUT_RDWR)
            except OSError: pass
            sock.close()
    def operation():
        try:
            connection.connect()
            wire[0] = connection.sock
            if expired.is_set(): return
            raw = None if body is None else json.dumps(body).encode()
            connection.request(method, parsed.path + ("?" + parsed.query if parsed.query else ""), body=raw, headers=headers)
            response = connection.getresponse()
            if not 200 <= response.status < 300: return
            data = response.read(2_000_001)
            if expired.is_set() or len(data) > 2_000_000: return
            result.append(json.loads(data) if data else {})
        except Exception:
            pass
        finally:
            connection.close()
            done.set()
    timer = threading.Timer(timeout, abort)
    timer.daemon = True
    timer.start()
    threading.Thread(target=operation, daemon=True).start()
    try:
        if not done.wait(timeout + 0.2) or expired.is_set() or not result:
            abort()
            raise PilotError("Remote request failed or outcome unconfirmed")
        return result[0]
    finally:
        abort()
        timer.cancel()


def validate(spec):
    if not isinstance(spec, dict) or not re.fullmatch(r"[A-Za-z0-9_-]+/[A-Za-z0-9_.-]+", spec.get("repository", "")):
        raise PilotError("Invalid repository")
    if not SHA.fullmatch(spec.get("baseSha", "")) or not spec.get("providerInstanceId"):
        raise PilotError("Pinned base and remote provider instance required")
    if not isinstance(spec.get("instruction"), str) or not 0 < len(spec["instruction"].strip()) <= 8000:
        raise PilotError("Task required")
    checks = spec.get("requiredChecks")
    if not isinstance(checks, list) or not 0 < len(checks) <= 10 or any(not isinstance(c, str) or not 0 < len(c) <= 100 for c in checks) or len(set(checks)) != len(checks):
        raise PilotError("Unique required CI checks required")
    if not isinstance(spec.get("baseBranch"), str) or not re.fullmatch(r"[A-Za-z0-9_./-]{1,200}", spec["baseBranch"]):
        raise PilotError("Base branch required for draft CI pull request")
    return spec


def checks_pass(head, required, checks, statuses):
    """Latest receipts only; missing, foreign-SHA and ambiguous names never pass."""
    for name in required:
        matches = [c for c in checks if c.get("name") == name]
        matching_status = [s for s in statuses if s.get("context") == name]
        if matches and matching_status:
            return False
        if matches:
            if len(matches) != 1 or matches[0].get("head_sha") != head or matches[0].get("status") != "completed" or matches[0].get("conclusion") != "success":
                return False
        elif len(matching_status) != 1 or matching_status[0].get("state") != "success":
            return False
        else:
            continue
    return bool(required)


class Box:
    def __init__(self, box_id, key, transport=request):
        if not re.fullmatch(r"[a-zA-Z0-9_-]{1,100}", box_id) or not key:
            raise PilotError("Box credentials absent")
        self.url, self.key, self.transport = BASE + box_id, key, transport
        self.work_deadline = None
        self.closed = False

    def api(self, path, method="GET", body=None, timeout=20):
        if path not in ("/status", "/pause") and (self.closed or (self.work_deadline is not None and time.time() + timeout + 5 >= self.work_deadline)):
            raise PilotError("Remote work admission closed before independent pause")
        return self.transport(self.url + path, self.key, method, body, box=True, timeout=timeout)

    def command(self, command, seconds=30):
        # No retries: a lost receipt may mean the command already ran.
        result = self.api("/exec", "POST", {"command": ["timeout", "--signal=TERM", "--kill-after=5", str(seconds), "bash", "-lc", "set -euo pipefail; " + command], "folder": "/workspace/home"}, timeout=seconds + 10)
        if result.get("exit_code") != 0:
            raise PilotError("Remote command failed; output withheld")
        return str(result.get("output", ""))

    def write(self, path, content):
        self.api("/files/write", "POST", {"path": path, "content": content})

    def read(self, path, timeout=20):
        data = self.api("/files/read?" + urllib.parse.urlencode({"path": path, "length": 16384}), timeout=timeout)
        return json.loads(data["content"])

    def pause(self):
        self.closed = True
        for _ in range(3):
            try:
                if self.api("/status", timeout=10).get("status") != "paused":
                    self.api("/pause", "POST", timeout=10)
                if self.api("/status", timeout=10).get("status") == "paused":
                    return True
            except PilotError:
                pass
        return False


class GitHub:
    def __init__(self, repo, token):
        self.root, self.token = "https://api.github.com/repos/" + repo, token

    def api(self, path, method="GET", body=None):
        return request(self.root + path, self.token, method, body)

    def ci(self, sha, required):
        checks = []
        for page in range(1, 11):
            data = self.api(f"/commits/{sha}/check-runs?filter=latest&per_page=100&page={page}")
            batch = data["check_runs"]
            checks.extend(batch)
            if len(batch) < 100:
                break
        else:
            raise PilotError("Check pagination limit")
        status = self.api(f"/commits/{sha}/status?per_page=100")
        if status.get("sha") != sha or status.get("total_count", 0) > 100:
            return False
        return checks_pass(sha, required, checks, status.get("statuses", []))


def receipt(value, filename="receipt.json"):
    if "stage" in value: print("Pilot stage:", value["stage"], flush=True)
    Path(filename).write_text(json.dumps(value, indent=2))


def watchdog(box, deadline, owner, run_id):
    # Separate workflow run: cancelling the controller cannot cancel this watchdog.
    try:
        while time.time() < deadline - 150:
            try:
                state = owner.api(f"/actions/runs/{run_id}")
            except PilotError:
                # Avoid an early asynchronous pause racing admitted controller work.
                # The controller closes work admission before this fixed pause point.
                while time.time() < deadline - 150:
                    time.sleep(min(15, deadline - 150 - time.time()))
                break
            if state.get("status") == "completed":
                break
            time.sleep(15)
    finally:
        paused = box.pause()
        receipt({"controllerRun": run_id, "cleanupConfirmed": paused, "finishedAt": int(time.time())}, "cleanup.json")
        if not paused:
            raise PilotError("Cleanup unconfirmed; manually pause the selected Box")


def stop_server(box, directory):
    if box.api("/status", timeout=10).get("status") == "paused":
        return False
    script = """const fs = require('node:fs');
const directory = process.argv[1];
const job = directory.split('/').at(-1);
if (!/^[a-f0-9]{32}$/.test(job)) process.exit(1);
let pid; try { pid = Number(fs.readFileSync(directory + '/server.pid', 'utf8')); }
catch (e) { if (e.code === 'ENOENT') process.exit(0); throw e; }
if (!Number.isSafeInteger(pid) || pid < 2) process.exit(1);
const proc = '/proc/' + pid;
if (!fs.existsSync(proc)) process.exit(0);
const expected = ['timeout', '--signal=TERM', '--kill-after=5', '650', 'node',
  '/workspace/home/t3-pilot/runtime/dist/bin.mjs', 'serve', '--host', '127.0.0.1',
  '--port', '3773', '--base-dir', '/workspace/home/t3-pilot/t3-home'];
const command = fs.readFileSync(proc + '/cmdline', 'utf8').split('\\0').filter(Boolean);
const env = fs.readFileSync(proc + '/environ', 'utf8').split('\\0');
if (JSON.stringify(command) !== JSON.stringify(expected) || !env.includes('T3_PILOT_JOB_ID=' + job)) process.exit(1);
process.kill(pid, 'SIGTERM');
for (let i = 0; i < 50; i++) {
  if (!fs.existsSync(proc)) process.exit(0);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
}
process.exit(1);
"""
    box.command("node -e " + shlex.quote(script) + " " + shlex.quote(directory), 8)
    return True


def start_server(box, directory, job_id, mode):
    if mode not in ("explicit-box-setup", "explicit-box-activation"):
        raise PilotError("Invalid worker mode")
    box.command(f"T3_PILOT_JOB_ID={job_id} T3_CLOUD_PILOT_ENABLED={mode} nohup timeout --signal=TERM --kill-after=5 650 node {ROOT}/runtime/dist/bin.mjs serve --host 127.0.0.1 --port 3773 --base-dir {ROOT}/t3-home >/dev/null 2>&1 & echo $! > {shlex.quote(directory)}/server.pid")


def setup_provider(box, spec, job_id, directory, deadline, runtime_mode):
    # User completes installation/OAuth in the tunneled T3 UI. No credential is read here.
    setup_deadline = min(time.time() + 480, deadline - 900)
    if setup_deadline <= time.time():
        raise PilotError("No setup budget remains")
    box.write(ROOT + "/turn.json", json.dumps({"id": job_id, "spec": spec, "attempt": 1,
        "deadline": int(setup_deadline * 1000), "runtimeMode": runtime_mode}))
    start_server(box, directory, job_id, "explicit-box-setup")
    while time.time() < setup_deadline:
        try:
            result = box.read(directory + "/setup.json", timeout=max(0.1, min(5, setup_deadline - time.time())))
        except PilotError:
            result = None
        if result and result.get("id") == job_id:
            if result.get("stage") == "setup-ready":
                if not stop_server(box, directory):
                    raise PilotError("Setup server stop unconfirmed")
                return
            if result.get("stage") in ("failed", "interrupted"):
                raise PilotError("Remote setup failed")
        time.sleep(max(0, min(2, setup_deadline - time.time())))
    raise PilotError("Eight-minute setup deadline reached")


def execute(box, spec, control, target, run_id, runtime_mode, artifact_url, artifact_sha):
    if target.api("").get("private") is not False:
        raise PilotError("This prototype accepts only an approved public repository")
    job_id = uuid.uuid4().hex
    draft_pr = None
    branch = "t3-cloud/" + job_id
    directory = ROOT + "/jobs/" + job_id
    deadline = int(time.time()) + 1800
    box.work_deadline = deadline - 300
    state = {"id": job_id, "stage": "preflight", "branch": branch, "sha": None, "cleanupConfirmed": False}
    receipt(state)
    if box.api("/status").get("status") != "paused":
        raise PilotError("Selected Box must be paused before arming watchdog")
    # Watchdog must already be running before resume. workflow_dispatch itself is not a receipt.
    control.api(f"/actions/workflows/{WATCHDOG_WORKFLOW}/dispatches", "POST", {
        "ref": os.environ["GITHUB_REF_NAME"], "inputs": {"controller_run": str(run_id), "deadline": str(deadline), "box_id": os.environ["T3_PILOT_BOX_ID"]}})
    for _ in range(24):
        runs = control.api(f"/actions/workflows/{WATCHDOG_WORKFLOW}/runs?event=workflow_dispatch&per_page=100")["workflow_runs"]
        ready = [r for r in runs if r.get("display_title") == f"pilot-watchdog-{run_id}" and r.get("status") == "in_progress" and r.get("head_sha") == os.environ["GITHUB_SHA"]]
        if any(any(a.get("name") == f"watchdog-ready-{run_id}" for a in control.api(f"/actions/runs/{r['id']}/artifacts")["artifacts"]) for r in ready):
            break
        time.sleep(5)
    else:
        raise PilotError("Watchdog did not acknowledge; Box not resumed")
    try:
        if box.api("/status").get("status") != "paused":
            raise PilotError("Selected Box must be paused")
        box.api("/resume", "POST")  # exactly once; ambiguous outcome goes to cleanup
        if box.api("/status").get("status") not in ("idle", "running"):
            raise PilotError("Resume unconfirmed")
        state["stage"] = "preparing"; receipt(state)
        q = shlex.quote
        # The URL is a short-lived signed artifact URL, never a GitHub bearer token.
        box.command(f"umask 077; mkdir -p {q(directory)} {ROOT}/runtime; curl --fail --silent --show-error --max-time 120 {q(artifact_url)} -o {q(directory)}/runtime.zip; unzip -q {q(directory)}/runtime.zip -d {q(directory)}/artifact; echo {q(artifact_sha + '  ' + directory + '/artifact/pilot-runtime.tgz')} | sha256sum -c - >/dev/null; tar -xzf {q(directory)}/artifact/pilot-runtime.tgz -C {ROOT}/runtime", 180)
        state["stage"] = "awaiting-user-setup"; receipt(state)
        setup_provider(box, spec, job_id, directory, deadline, runtime_mode)
        state["stage"] = "preparing-repository"; receipt(state)
        # Public repository clone; no write credential exists during install or agent execution.
        box.command(f"git clone --no-checkout https://github.com/{spec['repository']}.git {q(directory)}/repo && git -C {q(directory)}/repo checkout -b {q(branch)} {spec['baseSha']} && test $(git -C {q(directory)}/repo rev-parse HEAD) = {spec['baseSha']}", 120)
        box.command(f"cd {q(directory)}/repo; if test -f pnpm-lock.yaml; then corepack pnpm install --frozen-lockfile; elif test -f package-lock.json; then npm ci; else exit 42; fi", 180)
        for attempt in (1, 2):
            if time.time() >= deadline - 240:
                raise PilotError("Insufficient remaining budget")
            instruction = spec["instruction"] if attempt == 1 else spec["instruction"] + "\nFix the required CI checks for the last commit; keep this task scope. Required checks: " + ", ".join(spec["requiredChecks"])
            turn = {"id": job_id, "spec": {**spec, "instruction": instruction}, "attempt": attempt, "deadline": min(deadline - 180, int(time.time()) + 600) * 1000, "runtimeMode": runtime_mode}
            box.write(ROOT + "/turn.json", json.dumps(turn))
            start_server(box, directory, job_id, "explicit-box-activation")
            state.update(stage="agent", attempt=attempt); receipt(state)
            result = None
            for _ in range(130):
                time.sleep(5)
                try:
                    result = box.read(f"{directory}/turn-{attempt}.json")
                except PilotError:
                    continue
                if result.get("stage") not in ("starting", "running"):
                    break
            stop_server(box, directory)
            if not result or result.get("id") != job_id or result.get("stage") != "completed" or result.get("cleanupConfirmed") is not True:
                raise PilotError("Agent did not complete or cleanup is unconfirmed")
            # Reject task-authored workflows; prototype may only modify application files.
            box.command(f"cd {q(directory)}/repo; test -z \"$(git status --porcelain -- .github)\"; git add -A; if ! git diff --cached --quiet; then git -c user.name='T3 cloud pilot' -c user.email='t3-pilot@users.noreply.github.com' commit -m 'chore: cloud pilot task' >/dev/null; fi; git diff --exit-code {spec['baseSha']} HEAD -- .github >/dev/null")
            sha = box.command(f"git -C {q(directory)}/repo rev-parse HEAD").strip()
            if not SHA.fullmatch(sha):
                raise PilotError("Invalid commit receipt")
            # Upload a bundle; push runs on GitHub's controller so the agent never receives its token.
            box.command(f"git -C {q(directory)}/repo bundle create {q(directory)}/result.bundle {q(branch)} ^{spec['baseSha']}")
            bundle = box.api("/files/read?" + urllib.parse.urlencode({"path": directory + "/result.bundle", "encoding": "base64", "length": 1_000_000}))["content"]
            data = base64.b64decode(bundle, validate=True)
            if len(data) >= 1_000_000:
                raise PilotError("Bundle export exceeds pilot limit")
            Path("result.bundle").write_bytes(data)
            push_bundle(spec, branch, sha)
            remote = target.api("/git/ref/heads/" + branch)
            if remote["object"]["sha"] != sha:
                raise PilotError("Push receipt mismatch")
            if draft_pr is None:
                draft_pr = target.api("/pulls", "POST", {"title": "Disposable T3 cloud task", "body": "Experimental cloud task; do not merge. Automated CI iteration is limited to two attempts.", "head": branch, "base": spec["baseBranch"], "draft": True})["number"]
            state.update(stage="ci", sha=sha, pullRequest=draft_pr); receipt(state)
            for _ in range(40):
                if time.time() >= deadline - 180:
                    raise PilotError("CI deadline reached")
                if target.ci(sha, spec["requiredChecks"]):
                    state["stage"] = "succeeded"; receipt(state); return
                time.sleep(10)
        raise PilotError("Two attempts exhausted")
    finally:
        try:
            state["cancellationConfirmed"] = stop_server(box, directory)
        except PilotError:
            state["cancellationConfirmed"] = False
        state["cleanupConfirmed"] = box.pause()
        if state["stage"] != "succeeded": state["stage"] = "failed"
        receipt(state)
        if not state["cleanupConfirmed"]:
            raise PilotError("Cleanup unconfirmed")


def push_bundle(spec, branch, sha):
    import subprocess
    env = {**os.environ, "GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "http.https://github.com/.extraheader",
           "GIT_CONFIG_VALUE_0": "AUTHORIZATION: basic " + base64.b64encode(("x-access-token:" + os.environ["T3_PILOT_REPO_TOKEN"]).encode()).decode()}
    def git(*args):
        subprocess.run(["git", *args], check=True, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=90)
    git("init", "--bare", "push-repo")
    git("-C", "push-repo", "fetch", "https://github.com/" + spec["repository"] + ".git", spec["baseSha"])
    git("-C", "push-repo", "fetch", "../result.bundle", branch)
    # Recheck exported commits on the trusted controller before exposing write credentials to push.
    git("-C", "push-repo", "diff", "--exit-code", spec["baseSha"], sha, "--", ".github")
    git("-C", "push-repo", "push", "https://github.com/" + spec["repository"] + ".git", sha + ":refs/heads/" + branch)


def artifact_url(control):
    artifacts = control.api("/actions/runs/" + os.environ["GITHUB_RUN_ID"] + "/artifacts")["artifacts"]
    selected = [a for a in artifacts if a["name"] == "pilot-runtime" and not a["expired"]]
    if len(selected) != 1:
        raise PilotError("Exact-run runtime artifact absent")
    req = urllib.request.Request(selected[0]["archive_download_url"], headers={"Authorization": "Bearer " + control.token})
    try:
        urllib.request.build_opener(NoRedirect).open(req, timeout=20)
    except urllib.error.HTTPError as e:
        url = e.headers.get("Location", "")
        if e.code == 302 and urllib.parse.urlsplit(url).scheme == "https":
            return url
    raise PilotError("Artifact download URL unavailable")


def main():
    if os.environ.get("T3_PILOT_ACTIVATION") != "APPROVED_ZERO_EXTRA_30_MIN":
        raise PilotError("Live activation absent")
    def cancelled(signum, frame):
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        raise PilotError("Controller cancellation requested")
    if sys.argv[1:] != ["watchdog"]:
        signal.signal(signal.SIGTERM, cancelled)
        signal.signal(signal.SIGINT, cancelled)
    box = Box(os.environ["T3_PILOT_BOX_ID"], os.environ["T3_PILOT_BOX_API_KEY"])
    control = GitHub(os.environ["GITHUB_REPOSITORY"], os.environ["GH_TOKEN"])
    if sys.argv[1:] == ["watchdog-ready"]:
        if box.api("/status").get("status") != "paused":
            raise PilotError("Box must be paused before watchdog acknowledgement")
        receipt({"ready": True, "controllerRun": os.environ["PILOT_CONTROLLER_RUN"]}, "watchdog-ready.json")
        return
    if sys.argv[1:] == ["watchdog"]:
        deadline = int(os.environ["PILOT_DEADLINE"])
        if not time.time() - 3600 < deadline <= time.time() + 1800:
            raise PilotError("Invalid watchdog deadline")
        watchdog(box, deadline, control, int(os.environ["PILOT_CONTROLLER_RUN"]))
        return
    spec = validate(json.loads(os.environ["PILOT_SPEC"]))
    if spec["repository"] != os.environ["T3_PILOT_APPROVED_REPOSITORY"]:
        raise PilotError("Repository not approved")
    mode = os.environ.get("PILOT_RUNTIME_MODE", "approval-required")
    if mode not in ("approval-required", "auto-accept-edits"):
        raise PilotError("Invalid approval mode")
    execute(box, spec, control, GitHub(spec["repository"], os.environ["T3_PILOT_REPO_TOKEN"]), os.environ["GITHUB_RUN_ID"], mode, artifact_url(control), os.environ["PILOT_ARTIFACT_SHA256"])


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print("Pilot failed or outcome unconfirmed. Inspect receipts; do not retry an uncertain run.", file=sys.stderr)
        sys.exit(1)
