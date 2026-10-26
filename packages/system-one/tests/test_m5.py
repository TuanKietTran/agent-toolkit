import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest import skipUnless
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from system_one.client import decide, fallback_count
from system_one.llama_swap import edit_config, model_block, snippet
import yaml
from system_one.serve import create_server


BASE_SCENARIO = {
    "situation": "new",
    "prev_model": "",
    "complexity_hint": "medium",
    "context_tokens": 1000,
    "needs_images": False,
    "available": ["claude-sonnet-5-5", "claude-sonnet-5", "gpt-6.1-sol"],
    "headroom": {"claude": 1.0, "codex": 1.0},
}


def request_json(url, payload=None, headers=None):
    data = None if payload is None else json.dumps(payload).encode()
    request = urllib.request.Request(url, data=data, headers=headers or {}, method="POST" if data is not None else "GET")
    with urllib.request.urlopen(request, timeout=2) as response:
        return response.status, response.headers, response.read()


class ServeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = create_server("127.0.0.1", 0, Path("data/student_model.json"))
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def test_health_models_and_decide(self):
        status, _, body = request_json(f"{self.base}/health")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["status"], "ok")
        status, _, body = request_json(f"{self.base}/v1/models")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["data"][0]["id"], "system-one")
        status, _, body = request_json(f"{self.base}/v1/decide", BASE_SCENARIO, {"Content-Type": "application/json"})
        result = json.loads(body)
        self.assertEqual(status, 200)
        self.assertIn(result["model"], BASE_SCENARIO["available"])
        self.assertIn("degraded_level", result)
        status, _, body = request_json(f"{self.base}/v1/decide", {"situation": "new", "complexity_hint": "medium"}, {"Content-Type": "application/json"})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["degraded_level"], 0)

    def test_refusal_and_no_catalog_statuses(self):
        with self.assertRaises(urllib.error.HTTPError) as refused:
            request_json(f"{self.base}/v1/decide", {**BASE_SCENARIO, "kind": "permission"}, {"Content-Type": "application/json"})
        self.assertEqual(refused.exception.code, 400)
        with self.assertRaises(urllib.error.HTTPError) as unavailable:
            request_json(f"{self.base}/v1/decide", {**BASE_SCENARIO, "available": []}, {"Content-Type": "application/json"})
        self.assertEqual(unavailable.exception.code, 503)
        self.assertEqual(json.loads(unavailable.exception.read())["error"], "no_model_available")

    def test_type_field_is_a_declaration_too(self):
        # A caller that declares its decision with `type` instead of `kind` used to get a 200 model pick,
        # which looked like an answer to whatever it had asked (found 2026-10-18 via orchestrator-options).
        headers = {"Content-Type": "application/json"}
        for declared in ({"type": "decision_options"}, {"type": "permission_request"}, {"kind": "model_pick", "type": "permission_request"}, {"type": 5}):
            with self.subTest(declared=declared):
                with self.assertRaises(urllib.error.HTTPError) as refused:
                    request_json(f"{self.base}/v1/decide", {**BASE_SCENARIO, **declared}, headers)
                self.assertEqual(refused.exception.code, 400)
                self.assertEqual(json.loads(refused.exception.read())["error"], "decision_kind_refused")
        status, _, _ = request_json(f"{self.base}/v1/decide", {**BASE_SCENARIO, "type": "model_pick"}, headers)
        self.assertEqual(status, 200)

    def test_chat_and_sse(self):
        payload = {"messages": [{"role": "user", "content": "metadata {\"situation\":\"new\",\"available\":[\"claude-sonnet-5-5\"],\"headroom\":{\"claude\":1,\"codex\":0}}"}]}
        status, _, body = request_json(f"{self.base}/v1/chat/completions", payload, {"Content-Type": "application/json"})
        self.assertEqual(status, 200)
        result = json.loads(body)
        content = json.loads(result["choices"][0]["message"]["content"])
        self.assertEqual(content["model"], "claude-sonnet-5-5")
        stream = {**payload, "stream": True}
        status, headers, body = request_json(f"{self.base}/v1/chat/completions", stream, {"Content-Type": "application/json"})
        self.assertEqual(status, 200)
        self.assertEqual(headers.get_content_type(), "text/event-stream")
        self.assertIn(b"data: [DONE]", body)

    def test_garbage_chat_still_decides(self):
        payload = {"messages": [{"role": "user", "content": "not structured metadata"}]}
        status, _, body = request_json(f"{self.base}/v1/chat/completions", payload, {"Content-Type": "application/json"})
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(body)["choices"][0]["message"]["content"])


class LlamaSwapTextTests(unittest.TestCase):
    def _config(self, crlf=False, groups=False):
        newline = "\r\n" if crlf else "\n"
        text = (
            "# keep this comment\nmodels:\n"
            "  \"alpha\":\n    cmd: >\n      alpha --port ${PORT}\n    ttl: 0\n"
            "  \"beta\":\n    cmd: >\n      beta --port ${PORT}\n    ttl: 0\n"
            "  \"gamma\":\n    cmd: >\n      gamma --port ${PORT}\n    ttl: 0\n"
        )
        if groups:
            text += "groups:\n  \"existing\":\n    swap: true\n    members:\n      - \"alpha\"\n"
        return text.replace("\n", newline)

    def test_install_idempotency_backup_dry_run_and_uninstall(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "swap.yaml"
            original = self._config()
            path.write_text(original, encoding="utf-8")
            changed, _ = edit_config(path, True)
            self.assertTrue(changed)
            installed = path.read_text(encoding="utf-8")
            self.assertIn('"system-one":', installed)
            self.assertIn('"system-one-group":', installed)
            self.assertIn("# keep this comment", installed)
            self.assertTrue(list(Path(directory).glob("swap.yaml.bak-*-system-one*")))
            before = path.read_bytes()
            changed, _ = edit_config(path, True)
            self.assertFalse(changed)
            self.assertEqual(before, path.read_bytes())
            dry_copy = Path(directory) / "dry.yaml"
            dry_copy.write_text(original, encoding="utf-8")
            before = dry_copy.read_bytes()
            changed, diff = edit_config(dry_copy, True, dry_run=True)
            self.assertTrue(changed)
            self.assertIn("system-one", diff)
            self.assertEqual(before, dry_copy.read_bytes())
            changed, _ = edit_config(path, False)
            self.assertTrue(changed)
            uninstalled = path.read_text(encoding="utf-8")
            self.assertNotIn('"system-one":', uninstalled)
            self.assertNotIn('"system-one-group":', uninstalled)
            self.assertIn("# keep this comment", uninstalled)

    def test_crlf_and_existing_groups_are_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "swap.yaml"
            path.write_bytes(self._config(crlf=True, groups=True).encode())
            edit_config(path, True)
            result = path.read_bytes()
            self.assertNotIn(b"\n", result.replace(b"\r\n", b""))
            text = result.decode()
            self.assertIn('"existing":', text)
            self.assertIn('"system-one-group":', text)
            edit_config(path, False)
            text = path.read_text(encoding="utf-8")
            self.assertIn('"existing":', text)
            self.assertNotIn('"system-one-group":', text)

    def test_show_shape(self):
        text = snippet()
        for marker in ('"system-one":', "cmd: >", "proxy: http://127.0.0.1:${PORT}", '"system-one-group":', "swap: false", "persistent: true"):
            self.assertIn(marker, text)

    def test_windows_backslashes_use_single_quoted_env_scalars(self):
        project = Path("C:/Program Files/O'Brien/system-one")
        python = project / ".venv" / "Scripts" / "python.exe"
        text = "models:\n" + model_block(project, python) + "groups:\n  \"system-one-group\":\n    swap: false\n"
        parsed = yaml.safe_load(text)
        env = parsed["models"]["system-one"]["env"]
        self.assertEqual(env[0], "PYTHONPATH=C:\\Program Files\\O'Brien\\system-one\\src")
        self.assertEqual(env[1], "SYSTEM_ONE_STUDENT=C:\\Program Files\\O'Brien\\system-one\\data\\student_model.json")
        for line in text.splitlines():
            self.assertIsNone(re.search(r'^\s*-\s*"[^"]*\\', line), line)

    @skipUnless(Path(r"C:\\llama-swap\\llama-swap.exe").is_file(), "real llama-swap binary absent")
    def test_optional_real_llama_swap_temp_config(self):
        binary = Path(r"C:\\llama-swap\\llama-swap.exe")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "swap.yaml"
            path.write_text(self._config(), encoding="utf-8")
            edit_config(path, True)
            probe = socket.socket()
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
            probe.close()
            process = subprocess.Popen([str(binary), "-config", str(path), "-listen", f"127.0.0.1:{port}"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                deadline = time.monotonic() + 4.0
                response = None
                while time.monotonic() < deadline:
                    self.assertIsNone(process.poll())
                    try:
                        with urllib.request.urlopen(f"http://127.0.0.1:{port}/v1/models", timeout=0.2) as handle:
                            response = json.loads(handle.read())
                            break
                    except OSError:
                        time.sleep(0.1)
                self.assertIsNone(process.poll())
                self.assertIsNotNone(response)
                self.assertIn("system-one", [item.get("id") for item in response.get("data", [])])
            finally:
                process.terminate()
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=2)


class ClientTests(unittest.TestCase):
    def setUp(self):
        self.old = {key: os.environ.get(key) for key in ("SYSTEM_ONE_BACKEND", "LLAMA_SWAP_URL")}

    def tearDown(self):
        for key, value in self.old.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    def test_nothing_listening_falls_back(self):
        os.environ["SYSTEM_ONE_BACKEND"] = "auto"
        os.environ["LLAMA_SWAP_URL"] = "http://127.0.0.1:1"
        decision = decide(BASE_SCENARIO)
        self.assertIn(decision.model, BASE_SCENARIO["available"])

    def test_local_serve_is_used(self):
        server = create_server("127.0.0.1", 0, Path("data/student_model.json"))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            os.environ["SYSTEM_ONE_BACKEND"] = "auto"
            os.environ["LLAMA_SWAP_URL"] = f"http://127.0.0.1:{server.server_port}"
            before = fallback_count()
            decision = decide(BASE_SCENARIO)
            self.assertIn(decision.model, BASE_SCENARIO["available"])
            self.assertEqual(fallback_count(), before, "bare shim must answer without falling back")
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_llama_swap_passthrough_route_is_used(self):
        # Real llama-swap 404s /v1/decide; only /upstream/<model>/... reaches the model.
        class FakeSwap(BaseHTTPRequestHandler):
            seen: list[str] = []

            def log_message(self, *args):
                pass

            def _send(self, code, payload):
                raw = json.dumps(payload).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def do_GET(self):
                if self.path == "/v1/models":
                    self._send(200, {"data": [{"id": "system-one"}]})
                else:
                    self._send(404, {"error": "not found"})

            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", "0")))
                FakeSwap.seen.append(self.path)
                if self.path == "/upstream/system-one/v1/decide":
                    self._send(200, {"model": "gpt-6.1-sol", "rule": "FAKE_REMOTE", "reason": "via upstream",
                                     "degraded_level": 0, "kind": "model_pick"})
                else:
                    self._send(404, {"error": "404 page not found"})

        server = HTTPServer(("127.0.0.1", 0), FakeSwap)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            os.environ["SYSTEM_ONE_BACKEND"] = "auto"
            os.environ["LLAMA_SWAP_URL"] = f"http://127.0.0.1:{server.server_port}"
            before = fallback_count()
            decision = decide(BASE_SCENARIO)
            self.assertEqual(decision.rule, "FAKE_REMOTE")
            self.assertEqual(fallback_count(), before)
            self.assertEqual(FakeSwap.seen[0], "/upstream/system-one/v1/decide")
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
