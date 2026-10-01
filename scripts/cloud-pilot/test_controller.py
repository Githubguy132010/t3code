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
        with patch.object(pilot, "receipt") as save, patch.object(pilot.time, "time", side_effect=[0, 1651, 1651]), patch.object(pilot.time, "sleep"):
            pilot.watchdog(box, 1800, Owner(), 42)
            box.pause.assert_called_once()
            box.command.assert_not_called()
            self.assertTrue(save.call_args.args[0]["cleanupConfirmed"])

    def test_interrupted_wait_prevents_delayed_network_mutation(self):
        from unittest.mock import Mock
        done, expired = Mock(), threading.Event()
        done.wait.side_effect = pilot.PilotError("cancelled")
        connection = Mock(sock=None)
        worker = Mock()
        with patch.object(pilot.threading, "Event", side_effect=[done, expired]), patch.object(pilot.threading, "Thread", return_value=worker) as thread, patch.object(pilot.threading, "Timer"), patch.object(pilot.http.client, "HTTPSConnection", return_value=connection):
            with self.assertRaises(pilot.PilotError): pilot.request("https://example.test/exec", "synthetic", method="POST")
            self.assertTrue(expired.is_set())
            thread.call_args.kwargs["target"]()
            connection.request.assert_not_called()

    def test_work_admission_closes_before_watchdog_pause(self):
        from unittest.mock import Mock
        transport = Mock()
        box = pilot.Box("selected-box", "synthetic", transport)
        box.work_deadline = 1500
        with patch.object(pilot.time, "time", return_value=1470):
            with self.assertRaises(pilot.PilotError): box.command("true", 30)
        transport.assert_not_called()

    def test_pause_permanently_closes_local_work_admission(self):
        from unittest.mock import Mock
        transport = Mock(return_value={"status": "paused"})
        box = pilot.Box("selected-box", "synthetic", transport)
        self.assertTrue(box.pause())
        transport.reset_mock()
        with self.assertRaises(pilot.PilotError): box.command("true")
        transport.assert_not_called()

    def test_cancellation_never_executes_on_paused_box(self):
        from unittest.mock import Mock
        box = Mock(); box.api.return_value = {"status": "paused"}
        self.assertFalse(pilot.stop_server(box, pilot.ROOT + "/jobs/" + "a" * 32))
        box.command.assert_not_called()

    def test_committed_workflow_change_is_rejected_before_push(self):
        commands = []
        def run(command, **kwargs):
            commands.append(command)
            if "diff" in command: raise subprocess.CalledProcessError(1, command)
        with patch.dict(pilot.os.environ, {"T3_PILOT_REPO_TOKEN": "synthetic"}), patch.object(subprocess, "run", side_effect=run):
            with self.assertRaises(subprocess.CalledProcessError):
                pilot.push_bundle({"repository": "owner/repo", "baseSha": "a" * 40}, "task", "b" * 40)
        self.assertFalse(any("push" in command for command in commands))

    def test_setup_waits_for_matching_receipt_and_stops_before_task(self):
        from unittest.mock import Mock
        box = Mock()
        box.read.side_effect = [{"id": "b" * 32, "stage": "setup-ready"},
            {"id": "a" * 32, "stage": "setup-waiting"}, {"id": "a" * 32, "stage": "setup-ready"}]
        with patch.object(pilot.time, "time", return_value=100), patch.object(pilot.time, "sleep"), patch.object(pilot, "start_server") as start, patch.object(pilot, "stop_server", return_value=True) as stop:
            pilot.setup_provider(box, {"providerInstanceId": "codex"}, "a" * 32, "/job", 1900, "approval-required")
        self.assertEqual(box.read.call_count, 3)
        self.assertEqual(start.call_args.args[-1], "explicit-box-setup")
        stop.assert_called_once()

    def test_setup_deadline_never_starts_agent(self):
        from unittest.mock import Mock
        box = Mock()
        with patch.object(pilot.time, "time", side_effect=[100, 100, 581]), patch.object(pilot, "start_server") as start:
            with self.assertRaises(pilot.PilotError):
                pilot.setup_provider(box, {}, "a" * 32, "/job", 1900, "approval-required")
        self.assertEqual(start.call_args.args[-1], "explicit-box-setup")
        box.read.assert_not_called()

    def test_setup_failure_flows_through_confirmed_pause(self):
        from unittest.mock import Mock
        box = Mock(); box.api.side_effect = [{"status": "paused"}, {"status": "paused"}, {}, {"status": "running"}]; box.pause.return_value = True
        control = Mock(); control.api.side_effect = [{}, {"workflow_runs": [{"id": 7, "display_title": "pilot-watchdog-42", "status": "in_progress", "head_sha": "head"}]}, {"artifacts": [{"name": "watchdog-ready-42"}]}]
        target = Mock(); target.api.return_value = {"private": False}
        with patch.dict(pilot.os.environ, {"GITHUB_REF_NAME": "feature/upstash-cloud-pilot", "GITHUB_SHA": "head", "T3_PILOT_BOX_ID": "selected-box"}), patch.object(pilot, "setup_provider", side_effect=pilot.PilotError("setup deadline")), patch.object(pilot, "stop_server", return_value=True), patch.object(pilot, "receipt") as save:
            with self.assertRaises(pilot.PilotError):
                pilot.execute(box, {"repository": "owner/repo"}, control, target, 42, "approval-required", "https://example.test/artifact", "a" * 64)
        box.pause.assert_called_once()
        self.assertEqual(save.call_args.args[0]["stage"], "failed")
        self.assertTrue(save.call_args.args[0]["cleanupConfirmed"])
        self.assertEqual(box.command.call_count, 1)  # runtime install only; no repository or agent work


if __name__ == "__main__": unittest.main()
