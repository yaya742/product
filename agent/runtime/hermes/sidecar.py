"""Pinned Hermes AIAgent over private framed stdio. No model/tool loop is copied.

The TypeScript host owns credentials, business storage, permissions and budget.
Every model request (including a last-iteration summary) crosses the same SDK
transport. No native tools or autonomous workers are enabled by this adapter.
"""
from __future__ import annotations

import io
import json
import logging
import os
from pathlib import Path
import struct
import sys
import threading
import queue
import time
import traceback
import hashlib
from dataclasses import replace

INPUT = sys.stdin.buffer
OUTPUT = sys.stdout.buffer
sys.stdout = io.StringIO()  # Never parse Hermes terminal output as protocol.
sys.stderr = io.StringIO()  # Exception strings can contain private input.
sys.dont_write_bytecode = True
logging.disable(sys.maxsize)
MAX_FRAME = 16 * 1024 * 1024
LOCK = threading.RLock()
SEQUENCE = 0
START = None
PENDING = {}


_SAFE_ERROR_CODES = {
    "authentication", "quota", "protocol", "output_budget", "output_length",
    "provider_error", "request_failed", "child_call_failed", "host_closed",
}


def _safe_error_code(value):
    """Return a bounded provider/host code without forwarding private text."""
    if isinstance(value, dict):
        for key in ("code", "error_code", "reason", "type"):
            candidate = value.get(key)
            if isinstance(candidate, str) and candidate in _SAFE_ERROR_CODES:
                return candidate
    text = str(value or "")
    for code in _SAFE_ERROR_CODES:
        if code in text:
            return code
    return None


def _incomplete_diagnostics(result):
    """Expose only structural failure facts needed by the host UI."""
    failure = result.get("error")
    return {
        "code": "engine_incomplete",
        "interrupted": bool(result.get("interrupted")),
        "apiCalls": result.get("api_calls"),
        "completed": result.get("completed"),
        "failed": result.get("failed"),
        "errorType": type(failure).__name__ if failure is not None else None,
        "errorCode": _safe_error_code(failure),
        "hasFinalResponse": bool(result.get("final_response")),
    }


def read_exact(size):
    result = bytearray()
    while len(result) < size:
        part = INPUT.read(size - len(result))
        if not part:
            raise EOFError("host_closed")
        result.extend(part)
    return result


def read_frame():
    size = struct.unpack(">I", read_exact(4))[0]
    if size < 2 or size > MAX_FRAME:
        raise ValueError("invalid_frame_length")
    return json.loads(read_exact(size))


def emit(kind, payload, request_id=None):
    global SEQUENCE
    with LOCK:
        SEQUENCE += 1
        item = {
            "version": 1, "kind": kind, "sequence": SEQUENCE,
            "run_id": START["run_id"], "parent_run_id": START.get("parent_run_id"),
            "epoch": START["epoch"], "task_version": START["task_version"],
            "request_id": request_id, "payload": payload,
        }
        data = json.dumps(item, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(data) > MAX_FRAME:
            raise ValueError("output_frame_too_large")
        OUTPUT.write(struct.pack(">I", len(data)) + data)
        OUTPUT.flush()


def receive_responses():
    expected_sequence = 2
    try:
        while True:
            response = read_frame()
            if response.get("sequence") != expected_sequence or response.get("version") != 1:
                raise ValueError("host_sequence_mismatch")
            expected_sequence += 1
            with LOCK:
                target = PENDING.get(response.get("request_id"))
            if target is None:
                raise ValueError("unpaired_host_response")
            target.put(response)
    except BaseException:
        with LOCK:
            for target in PENDING.values():
                target.put({"error": "host_closed"})


def rpc(kind, payload, allow_error=False):
    with LOCK:
        request_id = f'{START["run_id"]}:{SEQUENCE + 1}'
        target = queue.Queue(maxsize=2)
        PENDING[request_id] = target
        emit(kind, payload, request_id)
    try:
        response = target.get(timeout=180)
        if response.get("error"):
            if allow_error:
                return {"_host_error": response["error"]}
            raise RuntimeError("host_request_rejected")
        for name in ("run_id", "epoch", "task_version"):
            if response.get(name) != START[name]:
                raise PermissionError("stale_host_response")
        if response.get("request_id") != request_id:
            raise ValueError("unpaired_host_response")
        return response["payload"]
    finally:
        with LOCK:
            PENDING.pop(request_id, None)


def bootstrap():
    root = Path(__file__).resolve().parents[2]
    source = root / ".runtime" / "hermes-agent"
    home = root / ".runtime" / "hermes-home"
    os.environ["HERMES_HOME"] = str(home)
    os.environ["ZAICHANG_HERMES_HOST"] = "1"
    os.environ["HERMES_RELAY_ENABLED"] = "false"
    os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
    os.chdir(home)
    sys.path.insert(0, str(source))

    # A fail-closed I/O boundary in this process, not a claim of OS sandboxing.
    # Python/dependency reads are allowed; user/workspace files are host tools.
    # Windows can expose the uv interpreter through a redirected logical path
    # (for example AppData\Roaming -> the app sandbox cache).  The audit event
    # reports the resolved path, so normalize both sides or every import from
    # the bundled standard library is rejected on a cold start.
    roots = [p.resolve() for p in (source, home, Path(sys.base_prefix), Path(sys.prefix), Path(__file__).parent)]
    def audit(event, args):
        if event in ("socket.connect", "socket.getaddrinfo", "subprocess.Popen", "os.system", "os.exec", "os.spawn"):
            raise PermissionError("sidecar_direct_io_forbidden")
        if event == "open" and not isinstance(args[0], int):
            file, mode, flags = args
            if (isinstance(mode, str) and any(c in mode for c in "wax+")) or (isinstance(flags, int) and flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC)):
                raise PermissionError("sidecar_persistence_forbidden")
            target = Path(file).resolve()
            if not any(target == allowed or target.is_relative_to(allowed) for allowed in roots):
                raise PermissionError("sidecar_private_read_forbidden:" + target.name)
        if event in ("os.remove", "os.rename", "os.rmdir", "os.mkdir"):
            raise PermissionError("sidecar_mutation_forbidden")
    # Imports may initialize static caches, but contain no user payload. Their
    # network and credential environment are still empty (host-spawn allowlist).
    from run_agent import AIAgent
    import httpx
    from openai import OpenAI
    import tempfile
    tempfile.gettempdir()  # Static OS probe before accepting any run content into AIAgent.
    sys.addaudithook(audit)

    class HostBoundary:
        def __init__(self, tools):
            self.tools = tools
            self.agent = None
            self.tasks = []
            self.child_index = 0
            self.children = []

        def create_child(self, **kwargs):
            task = self.tasks[self.child_index]
            self.child_index += 1
            ticket = rpc("child.open", {"agent_id": self.agent.host_id, "task": task})
            child = HostAgent({"agentId": ticket["id"], "system": ticket["system"], "tools": ticket["tools"], "thinking": "enabled", "maxIterations": 6, "maxOutputTokens": 4096}, iteration_budget=self.agent.iteration_budget)
            self.children.append(ticket["id"])
            return child

        def tool(self, name, args, call_id):
            if name not in {t["function"]["name"] for t in self.tools}:
                raise PermissionError("tool_not_in_host_catalog")
            if name == "delegate":
                rpc("delegate.authorize", {"agent_id": self.agent.host_id, "arguments": args, "tool_call_id": call_id})
                from tools.delegate_tool import delegate_task
                self.tasks = args["tasks"]
                self.child_index = 0
                self.children = []
                result = json.loads(delegate_task(tasks=[{"goal": task["instruction"]} for task in self.tasks], parent_agent=self.agent, background=False))
                for item in result.get("results", []):
                    item["model"] = self.agent._host_model_identity["model"]
                    item["providerId"] = self.agent._host_model_identity["providerId"]
                    item["temporaryTestSubstitute"] = self.agent._host_model_identity.get("temporaryTestSubstitute", False)
                    if item.get("cost_status") == "unknown":
                        item["cost_usd"] = None
                result["_host_children"] = list(self.children)
                rpc("delegate.result", {"agent_id": self.agent.host_id, "tool_call_id": call_id, "result": result})
                return json.dumps(result, ensure_ascii=False)
            return json.dumps(rpc("tool.request", {"agent_id": self.agent.host_id, "name": name, "arguments": args, "tool_call_id": call_id}), ensure_ascii=False)

    class HostAgent(AIAgent):
        def __init__(self, payload, iteration_budget=None):
            self.host_id = payload.get("agentId", START["run_id"])
            self._host_adapter = HostBoundary(payload["tools"])
            self._host_adapter.agent = self
            self._host_system = payload["system"]
            self._host_model_identity = START["payload"].get("modelIdentity") or {"model": "deepseek-flash", "providerId": "deepseek"}
            # This constant chooses the established Hermes wire dialect only.
            # Physical inference and its identity belong to the host adapter;
            # changing dialect here would also change the application loop.
            super().__init__(
                model="deepseek-flash", provider="custom", api_mode="chat_completions",
                base_url="https://api.deepseek.com", api_key="host-only",
                enabled_toolsets=[], quiet_mode=True, save_trajectories=False,
                skip_context_files=True, skip_memory=True, skip_background_review=True,
                max_iterations=payload.get("maxIterations", 12), max_tokens=payload.get("maxOutputTokens", 4096),
                session_id=self.host_id, session_db=None, fallback_model=None, iteration_budget=iteration_budget,
                request_overrides={"extra_body": {"thinking": {"type": payload.get("thinking", "enabled")}}},
            )
            self._persist_disabled = True
            self._tool_snapshot_generation = 1 << 60  # Host tool snapshot cannot be replaced by native plugin discovery.
            self._reasoning_echo_flag = True
            # Preserve the upstream controller's counts and hard-stop decisions.
            # Its coding-oriented instruction to keep calling tools even when
            # independent parts are answerable is not this product's behavior.
            upstream_after_call = self._tool_guardrails.after_call
            def host_after_call(*args, **kwargs):
                decision = upstream_after_call(*args, **kwargs)
                if decision.code == "same_tool_failure_warning":
                    return replace(decision, message=(
                        f"{decision.tool_name} has failed {decision.count} times. "
                        "Inspect the concrete error before retrying; do not repeat unchanged failures. "
                        "You may answer independent requests from already permitted evidence. "
                        "Optional storage is not a prerequisite for understanding the current message. "
                        "Explain any unfinished operation honestly; never claim it succeeded."
                    ))
                return decision
            self._tool_guardrails.after_call = host_after_call
            compression = payload.get("compression") or {}
            self.compression_enabled = bool(compression.get("enabled", False))
            self._micro_compact_enabled = False
            compressor = self.context_compressor
            compressor.abort_on_summary_failure = True
            compressor.threshold_tokens_cap = int(compression.get("thresholdTokens", 48000))
            compressor.threshold_tokens = compressor.threshold_tokens_cap
            compressor.protect_first_n = 1
            compressor.protect_last_n = 8
            compressor.proactive_prune_tokens = 0
            compressor._host_summary_call = self._summarize
            compressor._host_serialize = self._summary_input

        def _build_system_prompt(self, system_message=None):
            return self._host_system

        def _model_supports_vision(self):
            # The host fixes the verified native-multimodal DeepSeek route and
            # has already validated/normalized uploads. Never invoke a second
            # vision model, produce a caption, or materialize an image file.
            return True

        def _summary_input(self, turns):
            def content(value):
                if isinstance(value, list):
                    return [part if not isinstance(part, dict) or part.get("type") != "image_url" else {"type": "image_reference", "note": "Image excluded from text compaction; no caption or embedding was generated."} for part in value]
                return value
            material = [{key: content(value) if key == "content" else value for key, value in turn.items() if key in ("role", "content", "tool_calls", "tool_call_id")} for turn in turns]
            serialized = json.dumps(material, ensure_ascii=False)
            if len(serialized) > 1_000_000:
                raise RuntimeError("compaction_input_budget_no_truncation")
            return serialized

        def _summarize(self, prompt):
            result = rpc("model.request", {"agent_id": self.host_id, "phase": "compression", "model": self._host_model_identity["model"], "messages": [{"role": "user", "content": prompt}], "tools": [], "thinking": {"type": "enabled"}, "max_tokens": 8192})
            text = result["assistant"].get("content")
            if not isinstance(text, str) or not text.strip():
                raise RuntimeError("empty_compaction_summary")
            return text

        def _create_openai_client(self, client_kwargs, **kwargs):
            return OpenAI(api_key="host-only", base_url="https://api.deepseek.com", max_retries=0,
                          http_client=httpx.Client(transport=httpx.MockTransport(self._model_request)))

        def _model_request(self, request):
            body = json.loads(request.content)
            result = rpc("model.request", {**body, "model": self._host_model_identity["model"], "agent_id": self.host_id}, allow_error=True)
            if result.get("_host_error"):
                error = result["_host_error"]
                code = error.get("code", "request_failed") if isinstance(error, dict) else "host_closed"
                return httpx.Response(400, json={"error": {"message": "Host model boundary: " + str(code), "type": "invalid_request_error", "code": code}})
            assistant = result["assistant"]
            choice = {"index": 0, "message": assistant,
                      "finish_reason": "tool_calls" if assistant.get("tool_calls") else "stop"}
            data = {"id": result.get("id", "host-response"), "object": "chat.completion",
                    "created": int(time.time()), "model": self._host_model_identity["model"], "choices": [choice],
                    "usage": result.get("usage", {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0})}
            if body.get("stream"):
                delta = dict(assistant)
                if delta.get("tool_calls"):
                    delta["tool_calls"] = [{"index": i, **t} for i, t in enumerate(delta["tool_calls"])]
                chunk = {**data, "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": delta, "finish_reason": choice["finish_reason"]}]}
                return httpx.Response(200, headers={"content-type": "text/event-stream"},
                                      text="data: " + json.dumps(chunk) + "\n\ndata: [DONE]\n\n")
            return httpx.Response(200, json=data)

        def _invoke_tool(self, function_name, function_args, effective_task_id, tool_call_id=None, **kwargs):
            return self._host_adapter.tool(function_name, function_args, tool_call_id)

        def run_conversation(self, *args, **kwargs):
            child = self.host_id != START["run_id"]
            if child:
                rpc("child.started", {"agent_id": self.host_id})
            result = super().run_conversation(*args, **kwargs)
            if child:
                rpc("child.finished", {"agent_id": self.host_id, "status": "produced" if result.get("completed") and not result.get("error") else "failed"})
            return result

    return HostAgent


def main():
    global START
    START = read_frame()
    if START.get("kind") != "run.start" or START.get("version") != 1 or START.get("sequence") != 1:
        raise ValueError("invalid_start")
    try:
        Agent = bootstrap()
        threading.Thread(target=receive_responses, daemon=True, name="host-responses").start()
        payload = START["payload"]
        agent = Agent(payload)
        emit("run.ready", {"engine": "hermes", "commit": "d595e636c83aa0b9606d4e914e1140ae9c796897", "adapterSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), "python": sys.version.split()[0], "nativeTools": [], "persistence": "host", "compression": "host_mediated" if agent.compression_enabled else "disabled_explicitly"})
        history = payload.get("history", [])
        if (payload.get("compression") or {}).get("forceInitial"):
            history = agent.context_compressor.compress([{"role": "system", "content": payload["system"]}, *history], force=True)
        result = agent.run_conversation(payload["userMessage"], conversation_history=history, task_id=START["run_id"])
        if result.get("error") or result.get("failed") or result.get("completed") is False:
            emit("run.error", _incomplete_diagnostics(result))
            agent.close()
            return 1
        emit("run.final", {"content": result.get("final_response", ""), "messages": result.get("messages", []), "interrupted": result.get("interrupted", False), "compactions": agent.context_compressor.compression_count})
        agent.close()
    except BaseException as exc:
        # Keep debugging locations without exception messages or user payloads.
        detail = str(exc)
        emit("run.error", {"code": type(exc).__name__, "detail": detail[:160] if detail.startswith("sidecar_") else None, "frames": [{"file": Path(f.filename).name, "line": f.lineno, "function": f.name} for f in traceback.extract_tb(exc.__traceback__)[-7:]]})
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
