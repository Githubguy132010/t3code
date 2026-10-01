import importlib.util
from pathlib import Path
import unittest
import threading
import subprocess
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("pilot", Path(__file__).with_name("controller.py"))
pilot = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pilot)


class ControllerTests(unittest.TestCase):
    def test_missing_live_approval_never_calls_network(self):
        with patch.dict(pilot.os.environ, {}, clear=True), patch.object(pilot, "request") as request:
            with self.assertRaises(pilot.PilotError): pilot.main()
            request.assert_not_called()

    def test_missing_checks_cannot_pass(self):
        self.assertFalse(pilot.checks_pass("a" * 40, ["unit"], [], []))

    def test_wrong_sha_cannot_pass(self):
        self.assertFalse(pilot.checks_pass("a" * 40, ["unit"], [{"name": "unit", "head_sha": "b" * 40, "status": "completed", "conclusion": "success"}], []))

    def test_duplicate_names_cannot_pass(self):
        check = {"name": "unit", "head_sha": "a" * 40, "status": "completed", "conclusion": "success"}
        self.assertFalse(pilot.checks_pass("a" * 40, ["unit"], [check, check], []))

    def test_all_exact_sha_checks_required(self):
        check = {"name": "unit", "head_sha": "a" * 40, "status": "completed", "conclusion": "success"}
        self.assertTrue(pilot.checks_pass("a" * 40, ["unit"], [check], []))
        self.assertFalse(pilot.checks_pass("a" * 40, ["unit", "build"], [check], []))

    def test_ambiguous_check_and_status_cannot_pass(self):
        check = {"name": "unit", "head_sha": "a" * 40, "status": "completed", "conclusion": "success"}
        self.assertFalse(pilot.checks_pass("a" * 40, ["unit"], [check], [{"context": "unit", "state": "success"}]))

    def test_pause_reconciles_a_lost_post_receipt(self):
        paused = False
        posts = 0
        def transport(url, token, method, body, **kwargs):
            nonlocal paused, posts
            if method == "POST":
                posts += 1; paused = True
                raise pilot.PilotError("unknown outcome")
            return {"status": "paused" if paused else "running"}
        self.assertTrue(pilot.Box("selected-box", "synthetic", transport).pause())
        self.assertEqual(posts, 1)

    def test_cleanup_exhaustion_stays_unconfirmed(self):
        calls = 0
        def transport(*args, **kwargs):
            nonlocal calls
            calls += 1
            raise pilot.PilotError("offline")
        self.assertFalse(pilot.Box("selected-box", "synthetic", transport).pause())
        self.assertEqual(calls, 3)

    def test_exec_mutation_is_never_retried(self):
        calls = 0
        def transport(*args, **kwargs):
            nonlocal calls
            calls += 1
            raise pilot.PilotError("unknown")
        with self.assertRaises(pilot.PilotError): pilot.Box("selected-box", "synthetic", transport).command("true")
        self.assertEqual(calls, 1)

    def test_dns_delay_has_total_deadline_and_never_sends_late_request(self):
        release = threading.Event()
        class Connection:
            sock = None
            def connect(self): release.wait(2)
            def close(self): pass
            def request(self, *args, **kwargs): raise AssertionError("Late request")
        with patch.object(pilot.http.client, "HTTPSConnection", return_value=Connection()):
            try:
                with self.assertRaises(pilot.PilotError):
                    pilot.request("https://api.github.com/test", "synthetic", timeout=0.01)
            finally:
                release.set()

    def test_watchdog_pauses_if_github_monitoring_fails(self):
        class Owner:
            def api(self, path): raise pilot.PilotError("GitHub unavailable")
        from unittest.mock import Mock
        box = Mock(); box.pause.return_value = True
        with patch.object(pilot, "receipt") as save:
            with self.assertRaises(pilot.PilotError):
                pilot.watchdog(box, pilot.time.time() + 1800, Owner(), 42)
            box.pause.assert_called_once()
            self.assertTrue(save.call_args.args[0]["cleanupConfirmed"])

    def test_committed_workflow_change_is_rejected_before_push(self):
        commands = []
        def run(command, **kwargs):
            commands.append(command)
            if "diff" in command: raise subprocess.CalledProcessError(1, command)
        with patch.dict(pilot.os.environ, {"T3_PILOT_REPO_TOKEN": "synthetic"}), patch.object(subprocess, "run", side_effect=run):
            with self.assertRaises(subprocess.CalledProcessError):
                pilot.push_bundle({"repository": "owner/repo", "baseSha": "a" * 40}, "task", "b" * 40)
        self.assertFalse(any("push" in command for command in commands))


if __name__ == "__main__": unittest.main()
