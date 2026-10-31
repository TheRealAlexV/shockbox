"""Thin HTTP client for ShockBox's own API. Stdlib only (``urllib``), no requests.

Endpoints this speaks (shapes taken from ``core/server-http.mjs``, ``core/pool.mjs`` and the
module route files, not guessed):

    GET   /health              {ok, service, version, pid, port, modules:{id:status},
                                obs:{state, scene}, uptime, clients, channels}
    GET   /api/core/settings   {ok, settings:{key:{type,label,group,min,max,values,items,value}}}
    PATCH /api/core/settings   body {key:value}  -> {ok, changed:[...]}
    GET   /api/<module>/settings {ok, ...settings:{...}}   (module routes, e.g. notifications)
    PATCH /api/<module>/settings body {key:value} -> {ok, changed, settings}
    GET   /api/modules         {ok, modules:[{id, status, ...}]}
    GET   /api/pools           {pools:[{id,name,count}], types, tags, counts}

Everything is bounded by a timeout: the TUI renders against a server that may be mid-restart,
and a hung socket must never freeze the UI thread. ``ApiError`` carries the server's status
code and ``error`` field; connection failures raise ``ApiUnreachable`` (a normal state).
"""

from __future__ import annotations

import json
import socket
import urllib.error
import urllib.request
from typing import Any

DEFAULT_TIMEOUT = 3.0


class ApiError(Exception):
    """The server answered, but not with success."""

    def __init__(self, status: int, message: str, payload: Any = None):
        super().__init__(f"HTTP {status}: {message}")
        self.status = status
        self.message = message
        self.payload = payload


class ApiUnreachable(Exception):
    """Nothing answered on the socket (server down, restarting, or the wrong port)."""


class ApiClient:
    def __init__(self, port: int, host: str = "127.0.0.1", timeout: float = DEFAULT_TIMEOUT):
        self.port = int(port)
        self.host = host
        self.timeout = float(timeout)

    # ---- plumbing ---------------------------------------------------------------
    @property
    def base(self) -> str:
        return f"http://{self.host}:{self.port}"

    def _request(self, method: str, path: str, body: Any = None) -> Any:
        data = None
        headers = {"accept": "application/json"}
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["content-type"] = "application/json"
        req = urllib.request.Request(self.base + path, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as res:
                raw = res.read()
        except urllib.error.HTTPError as err:
            raw = err.read() if hasattr(err, "read") else b""
            payload = _maybe_json(raw)
            message = (payload or {}).get("error") if isinstance(payload, dict) else None
            raise ApiError(err.code, message or err.reason or "request failed", payload) from None
        except (urllib.error.URLError, socket.timeout, ConnectionError, OSError) as err:
            reason = getattr(err, "reason", err)
            raise ApiUnreachable(str(reason)) from None
        payload = _maybe_json(raw)
        if payload is None:
            raise ApiError(200, f"non-JSON body from {path}", raw[:200])
        return payload

    def get(self, path: str) -> Any:
        return self._request("GET", path)

    def patch(self, path: str, body: dict) -> Any:
        return self._request("PATCH", path, body)

    def request(self, method: str, path: str, body: Any = None) -> Any:
        """Any verb. The TUI's module screens need POST and DELETE, which had no wrapper."""
        return self._request(method.upper(), path, body)

    # ---- endpoints ---------------------------------------------------------------
    def health(self) -> dict:
        return self.get("/health")

    def settings(self) -> dict:
        """Core settings: ``{key: {type, label, value, ...}}``."""
        return self.get("/api/core/settings").get("settings", {})

    def patch_settings(self, changes: dict) -> list[str]:
        """PATCH core settings; returns the list of keys that actually changed."""
        out = self.patch("/api/core/settings", changes)
        return list(out.get("changed") or [])

    def module_settings(self, module_id: str) -> dict:
        return self.get(f"/api/{module_id}/settings").get("settings", {})

    def patch_module_settings(self, module_id: str, changes: dict) -> dict:
        return self.patch(f"/api/{module_id}/settings", changes)

    def modules(self) -> list:
        return self.get("/api/modules").get("modules", [])

    def pools(self) -> dict:
        return self.get("/api/pools")

    def is_up(self) -> bool:
        try:
            return bool(self.health().get("ok"))
        except (ApiError, ApiUnreachable):
            return False

    def pid(self) -> int | None:
        try:
            return int(self.health().get("pid"))
        except (ApiError, ApiUnreachable, TypeError, ValueError):
            return None


def _maybe_json(raw: bytes) -> Any:
    if not raw:
        return {}
    try:
        return json.loads(raw.decode("utf-8", "replace"))
    except (ValueError, UnicodeDecodeError):
        return None
