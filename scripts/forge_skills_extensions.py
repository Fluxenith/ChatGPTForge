"""Forge launch-layer additions to the pinned Skills Manager headless MCP.

Upstream 0.3.0 (5464464) implements stage failure in its engine
(RunService.fail_current: bounded retry, then fallback skill bindings, then a
fallback stage, otherwise run failure) but its headless MCP exposes no tool for
it. This adds exactly one tool, ``run_fail``, that calls that unchanged engine
method inside the service's own database transaction. The upstream source tree
is not modified; like the Windows MIME correction, this is applied at launch.
"""
from __future__ import annotations

from typing import Any

RUN_FAIL = {
    "name": "run_fail",
    "description": (
        "Record a failed gate for the current running stage. The engine applies the "
        "stage's retry bound, then fallback skill bindings, then its fallback stage, "
        "otherwise fails the run."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {"run_id": {"type": "string"}, "gate_result": {"type": "object"}},
        "required": ["run_id", "gate_result"],
        "additionalProperties": False,
    },
}


def install(server: Any) -> None:
    """Register run_fail on the upstream headless server module (idempotent)."""
    if getattr(server, "_forge_run_fail_installed", False):
        return
    from skill_control_plane.run_state import RunService

    original_schema = server.headless_tools_schema
    original_call = server.call_tool

    def headless_tools_schema() -> list[dict[str, Any]]:
        return original_schema() + [RUN_FAIL]

    def call_tool(registry: Any, name: str, arguments: dict[str, Any], *, db: Any = None) -> dict[str, Any]:
        if name != "run_fail":
            return original_call(registry, name, arguments, db=db)
        try:
            gate = arguments.get("gate_result")
            if not isinstance(gate, dict) or gate.get("passed") is not False:
                raise TypeError("gate_result must be an object with passed=false")
            if db is None:
                raise ValueError("run_fail requires the control-plane database")
            return server._tool_result(RunService(db).fail_current(str(arguments.get("run_id", "")), gate))
        except Exception as exc:  # Same error envelope as upstream call_tool.
            return server._tool_result({"error": type(exc).__name__, "detail": str(exc)}, is_error=True)

    server.headless_tools_schema = headless_tools_schema
    server.call_tool = call_tool
    server._forge_run_fail_installed = True
