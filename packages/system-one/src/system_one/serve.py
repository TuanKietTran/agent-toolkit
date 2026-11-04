"""Local HTTP adapter for llama-swap; standard library only."""

from __future__ import annotations

import json
import os
import sys
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from .guard import DecisionKindError, DecisionGuard
from .policy import Decision, NoModelAvailable, pick_model
from .student import StudentPredictor, load_predictor

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_STUDENT = PROJECT_ROOT / "data" / "student_model.json"


def _decision_dict(decision: Decision) -> dict[str, Any]:
    return {
        "model": decision.model,
        "rule": decision.rule,
        "reason": decision.reason,
        "degraded_level": decision.degraded_level,
        "kind": decision.kind,
    }


class DecisionBackend:
    def __init__(self, student_path: Path | None = None) -> None:
        self.student: StudentPredictor | None = None
        path = student_path or Path(os.environ.get("SYSTEM_ONE_STUDENT", str(DEFAULT_STUDENT)))
        try:
            if path.is_file():
                self.student = load_predictor(path)
        except Exception:
            self.student = None

    def decide(self, payload: dict[str, Any]) -> Decision:
        # `kind` and `type` both declare what is being decided. Either one naming anything but model_pick is
        # refused; a payload with neither is a plain model-pick scenario.
        guard = DecisionGuard()
        for kind in [payload[key] for key in ("kind", "type") if key in payload] or ["model_pick"]:
            guard.check(kind)
        if self.student is not None:
            try:
                return self.student.predict(payload)
            except NoModelAvailable:
                raise
            except Exception:
                pass
        return pick_model(payload)


def _first_json_object(text: str) -> dict[str, Any]:
    decoder = json.JSONDecoder()
    for index, char in enumerate(text):
        if char != "{":
            continue
        try:
            value, _ = decoder.raw_decode(text[index:])
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value
    return {}


def _scenario_from_chat(payload: dict[str, Any]) -> dict[str, Any]:
    messages = payload.get("messages")
    if not isinstance(messages, list):
        return {}
    for message in reversed(messages):
        if not isinstance(message, dict) or message.get("role") != "user":
            continue
        content = message.get("content")
        if isinstance(content, str):
            return _first_json_object(content)
        if isinstance(content, list):
            for part in content:
                if isinstance(part, dict) and isinstance(part.get("text"), str):
                    found = _first_json_object(part["text"])
                    if found:
                        return found
    return {}


def _json_bytes(value: Any) -> bytes:
    return json.dumps(value, separators=(",", ":"), sort_keys=True).encode("utf-8")


class _Handler(BaseHTTPRequestHandler):
    server_version = "system-one/0.1"

    @property
    def backend(self) -> DecisionBackend:
        return self.server.backend  # type: ignore[attr-defined]

    def log_message(self, format: str, *args: Any) -> None:
        # Request bodies and formatted exception details never enter logs.
        return

    def _respond(self, status: int, value: Any, content_type: str = "application/json") -> None:
        body = _json_bytes(value)
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict[str, Any]:
        try:
            length = max(0, int(self.headers.get("Content-Length", "0")))
            raw = self.rfile.read(length)
            value = json.loads(raw.decode("utf-8")) if raw else {}
            return value if isinstance(value, dict) else {}
        except (ValueError, UnicodeError, json.JSONDecodeError):
            return {}

    def do_GET(self) -> None:  # noqa: N802
        started = time.perf_counter()
        status = 200
        try:
            if self.path == "/health":
                self._respond(200, {"status": "ok"})
            elif self.path == "/v1/models":
                self._respond(200, {"object": "list", "data": [{"id": "system-one", "object": "model", "owned_by": "system-one"}]})
            else:
                status = 404
                self._respond(status, {"error": "not_found"})
        finally:
            self._access(status, started)

    def do_POST(self) -> None:  # noqa: N802
        started = time.perf_counter()
        status = 200
        try:
            payload = self._read_json()
            if self.path == "/v1/decide":
                status = self._decide(payload)
            elif self.path == "/v1/chat/completions":
                status = self._chat(payload)
            else:
                status = 404
                self._respond(status, {"error": "not_found"})
        except DecisionKindError:
            status = 400
            self._respond(status, {"error": "decision_kind_refused"})
        except NoModelAvailable:
            status = 503
            self._respond(status, {"error": "no_model_available"})
        except Exception:
            # Malformed or unexpected metadata follows autonomous defaults; a
            # genuine empty catalog remains the only model-pick error above.
            try:
                decision = self.backend.decide({})
                self._respond(200, _decision_dict(decision))
            except NoModelAvailable:
                status = 503
                self._respond(status, {"error": "no_model_available"})
        finally:
            self._access(status, started)

    def _decide(self, payload: dict[str, Any]) -> int:
        decision = self.backend.decide(payload)
        self._respond(200, _decision_dict(decision))
        return 200

    def _chat(self, payload: dict[str, Any]) -> int:
        scenario = _scenario_from_chat(payload)
        decision = self.backend.decide(scenario)
        content = json.dumps(_decision_dict(decision), separators=(",", ":"), sort_keys=True)
        if payload.get("stream") is True:
            chunk = {"id": f"system-one-{uuid.uuid4().hex[:12]}", "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": {"role": "assistant", "content": content}, "finish_reason": None}]}
            body = f"data: {json.dumps(chunk, separators=(',', ':'))}\n\ndata: [DONE]\n\n".encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return 200
        response = {
            "id": f"system-one-{uuid.uuid4().hex[:12]}",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": "system-one",
            "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}],
        }
        self._respond(200, response)
        return 200

    def _access(self, status: int, started: float) -> None:
        line = {"method": self.command, "path": self.path, "status": status, "ms": round((time.perf_counter() - started) * 1000, 3)}
        print(json.dumps(line, separators=(",", ":")), file=sys.stderr, flush=True)


def create_server(host: str = "127.0.0.1", port: int = 0, student_path: Path | None = None) -> ThreadingHTTPServer:
    server = ThreadingHTTPServer((host, port), _Handler)
    server.backend = DecisionBackend(student_path)  # type: ignore[attr-defined]
    return server


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description="Serve system-one as a local OpenAI-compatible model")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args(argv)
    server = create_server(args.host, args.port)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
