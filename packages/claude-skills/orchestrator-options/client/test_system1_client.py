"""Standard-library tests for system1_client.py (no network, no API key, no anthropic package).

    python -m unittest discover -s orchestrator-options/client -p "test_*.py"
"""
import copy
import io
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from contextlib import redirect_stderr
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import system1_client as c  # noqa: E402

EXAMPLE = json.loads((HERE.parent / "examples" / "ruxt-labs.briefing.json").read_text(encoding="utf-8"))


class Stub:
    """A local HTTP endpoint that records the last request and answers with a fixed status and body."""

    def __init__(self, status=200, body="{}"):
        self.status, self.body, self.seen = status, body, []
        stub = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                length = int(self.headers.get("Content-Length", 0))
                stub.seen.append(json.loads(self.rfile.read(length)))
                data = stub.body.encode()
                self.send_response(stub.status)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def log_message(self, *args):
                pass

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_port}/decide"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class ValidateTests(unittest.TestCase):
    def test_example_is_valid(self):
        self.assertEqual(c.validate_briefing(EXAMPLE), [])

    def test_template_is_not_sendable(self):
        problems = c.validate_briefing(c.TEMPLATE)
        self.assertTrue(any("TODO" in p for p in problems), problems)

    def test_permission_decision_is_refused(self):
        for decision in ("Should we approve the pending tool call?", "Grant the worker push access", "Allow-list the registry"):
            briefing = copy.deepcopy(EXAMPLE)
            briefing["decision"] = decision
            problems = c.validate_briefing(briefing)
            self.assertTrue(any("permissions" in p for p in problems), (decision, problems))

    def test_permission_option_title_is_refused(self):
        briefing = copy.deepcopy(EXAMPLE)
        briefing["options"][1]["title"] = "Ask for consent first"
        self.assertTrue(any("permissions" in p for p in c.validate_briefing(briefing)))

    def test_ordinary_words_are_not_refused(self):
        briefing = copy.deepcopy(EXAMPLE)
        briefing["decision"] = "Allow parallel runs of the build, and confirm the order of the jobs"
        self.assertEqual(c.validate_briefing(briefing), [])

    def test_bad_enum_and_bad_recommendation(self):
        briefing = copy.deepcopy(EXAMPLE)
        briefing["options"][0]["risk"] = "extreme"
        briefing["recommendation"]["option_id"] = "Z"
        problems = " ".join(c.validate_briefing(briefing))
        self.assertIn("'risk'", problems)
        self.assertIn("recommendation.option_id", problems)


class PayloadAndSendTests(unittest.TestCase):
    def test_payload_carries_kind_so_system_one_refuses_it_loudly(self):
        payload = c.build_payload(EXAMPLE, None)
        self.assertEqual(payload["kind"], "decision_options")
        self.assertEqual(payload["type"], "decision_options")
        self.assertEqual(payload["recommended_option_id"], "A")

    def test_send_posts_briefing(self):
        stub = Stub(200, '{"accepted": true}')
        try:
            with mock.patch.dict(os.environ, {"SYSTEM1_API_URL": stub.url}):
                self.assertIn("accepted", c.send_to_system1(EXAMPLE))
            self.assertEqual(stub.seen[0]["kind"], "decision_options")
        finally:
            stub.close()

    def test_model_pick_reply_is_an_error_not_a_success(self):
        stub = Stub(200, '{"kind": "model_pick", "model": "gpt-6.1-sol"}')
        try:
            with mock.patch.dict(os.environ, {"SYSTEM1_API_URL": stub.url}):
                with self.assertRaises(c.SendError) as ctx:
                    c.send_to_system1(EXAMPLE)
            self.assertIn("model pick", str(ctx.exception))
        finally:
            stub.close()

    def test_http_refusal_is_reported(self):
        stub = Stub(400, '{"error": "decision_kind_refused"}')
        try:
            with mock.patch.dict(os.environ, {"SYSTEM1_API_URL": stub.url}):
                with self.assertRaises(c.SendError) as ctx:
                    c.send_to_system1(EXAMPLE)
            self.assertIn("decision_kind_refused", str(ctx.exception))
        finally:
            stub.close()

    def test_invalid_briefing_is_never_sent(self):
        stub = Stub()
        try:
            bad = copy.deepcopy(EXAMPLE)
            bad["decision"] = "Approve the request"
            with mock.patch.dict(os.environ, {"SYSTEM1_API_URL": stub.url}):
                with self.assertRaises(c.SendError):
                    c.send_to_system1(bad)
            self.assertEqual(stub.seen, [])
        finally:
            stub.close()

    def test_file_sink_appends_json_lines(self):
        with tempfile.TemporaryDirectory() as tmp:
            sink = Path(tmp) / "inbox" / "orders.jsonl"
            with mock.patch.dict(os.environ, {"SYSTEM1_API_URL": f"file:{sink}"}):
                c.send_to_system1(EXAMPLE)
                c.send_to_system1(EXAMPLE, chosen="C")
            lines = sink.read_text(encoding="utf-8").splitlines()
            self.assertEqual(len(lines), 2)
            self.assertEqual(json.loads(lines[1])["chosen_option_id"], "C")
            self.assertIn("received_at", json.loads(lines[0]))

    def test_missing_url_is_a_clear_error(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("SYSTEM1_API_URL", None)
            with self.assertRaises(c.SendError) as ctx:
                c.send_to_system1(EXAMPLE)
        self.assertIn("SYSTEM1_API_URL", str(ctx.exception))


class PickTests(unittest.TestCase):
    def test_pick_sends_model_pick_only(self):
        stub = Stub(200, '{"kind": "model_pick", "model": "gpt-6-luna"}')
        try:
            args = mock.Mock(situation="existing", complexity="high", prev_model="gpt-6-luna", context_tokens=1000,
                             available="gpt-6-luna, gpt-6.1-sol", headroom_claude=None, headroom_codex=0.5)
            with mock.patch.dict(os.environ, {"SYSTEM1_PICK_URL": stub.url}):
                reply = c.pick_model(args)
            sent = stub.seen[0]
            self.assertEqual(sent["kind"], "model_pick")
            self.assertEqual(sent["available"], ["gpt-6-luna", "gpt-6.1-sol"])
            self.assertEqual(sent["headroom"], {"codex": 0.5})
            self.assertIn("gpt-6-luna", reply)
        finally:
            stub.close()


class CommandLineTests(unittest.TestCase):
    def run_cli(self, *args, env=None):
        full_env = {**os.environ, **(env or {})}
        return subprocess.run([sys.executable, str(HERE / "system1_client.py"), *args],
                              capture_output=True, text=True, env=full_env, timeout=30)

    def test_template_needs_no_dependencies(self):
        result = self.run_cli("template")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["options"][0]["id"], "A")

    def test_dry_run_send_prints_payload(self):
        result = self.run_cli("send", str(HERE.parent / "examples" / "ruxt-labs.briefing.json"), "--dry-run")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["kind"], "decision_options")

    def test_unfilled_template_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "t.json"
            path.write_text(json.dumps(c.TEMPLATE), encoding="utf-8")
            result = self.run_cli("send", str(path), "--dry-run")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("TODO", result.stderr)

    def test_options_without_sdk_exits_2_with_instructions(self):
        with mock.patch.dict(sys.modules, {"anthropic": None}):
            buf = io.StringIO()
            with redirect_stderr(buf), self.assertRaises(SystemExit) as ctx:
                c.generate_briefing("anything")
        self.assertEqual(ctx.exception.code, 2)
        self.assertIn("template", buf.getvalue())


if __name__ == "__main__":
    unittest.main()
