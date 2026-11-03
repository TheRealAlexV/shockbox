"""Thin HTTP client for ShockBox's own API. Stdlib only (``http.client``), no requests.

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

import http.client
import json
import threading
from typing import Any

DEFAULT_TIMEOUT = 3.0

# Verbs safe to replay when a *reused* socket turns out to be dead. A dead socket is not
# evidence that the server is down, so these retry once on a fresh connection; anything that
# changes state is never retried, because it may have been delivered before the socket broke.
_IDEMPOTENT = frozenset({"GET", "HEAD"})


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
        # One keep-alive connection, kept across calls. The supervisor polls /health every two
        # seconds for as long as the rig is up; a fresh TCP connect per poll is pure syscall cost
        # (it showed up as ~30 ms of CPU per minute of idle, a third of the whole tick budget).
        self._conn: http.client.HTTPConnection | None = None
        self._lock = threading.Lock()

    # ---- plumbing ---------------------------------------------------------------
    @property
    def base(self) -> str:
        return f"http://{self.host}:{self.port}"

    def close(self) -> None:
        """Drop the keep-alive socket (the server is stopping, or this client is done)."""
        with self._lock:
            self._close_locked()

    def _close_locked(self) -> None:
        conn, self._conn = self._conn, None
        if conn is not None:
            try:
                conn.close()
            except Exception:  # a socket already gone is the normal case here
                pass

    def _connection_locked(self) -> tuple[http.client.HTTPConnection, bool]:
        """``(connection, reused)``. ``reused`` tells the caller a failure may just be staleness."""
        conn = self._conn
        if conn is not None:
            return conn, True
        conn = http.client.HTTPConnection(self.host, self.port, timeout=self.timeout)
        self._conn = conn
        return conn, False

    def _request(self, method: str, path: str, body: Any = None) -> Any:
        method = method.upper()
        data = None
        headers = {"accept": "application/json", "connection": "keep-alive"}
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["content-type"] = "application/json"
        replay = method in _IDEMPOTENT
        timeout = self.timeout
        with self._lock:
            for attempt in (0, 1):
                conn, reused = self._connection_locked()
                try:
                    conn.request(method, path, body=data, headers=headers)
                    res = conn.getresponse()
                    raw = res.read()
                except (http.client.HTTPException, OSError) as err:
                    # A socket the server dropped while idle raises here. That is not the server
                    # being down, so a reused connection is retried once; a failure on a *fresh*
                    # connect (refused, timed out) is real and must stay ApiUnreachable.
                    self._close_locked()
                    if attempt == 0 and reused and replay:
                        continue
                    reason = getattr(err, "reason", None) or err
                    if isinstance(err, TimeoutError) or "timed out" in str(reason):
                        reason = f"timed out after {timeout:g}s"
                    raise ApiUnreachable(str(reason)) from None
                if res.status >= 400 or res.will_close:
                    self._close_locked()
                break
        if res.status >= 400:
            payload = _maybe_json(raw)
            message = payload.get("error") if isinstance(payload, dict) else None
            raise ApiError(res.status, message or res.reason or "request failed", payload)
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
