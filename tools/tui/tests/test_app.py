"""Headless tests for the Textual layer against a fake Control.

Nothing here spawns node: ``FakeControl`` is a plain object with the same method names returning
canned documents, and records every mutating call so a test can assert exactly what a click sent.
That is the point — the screen's job is to render documents and forward intent, and both are
checkable without a server.

``pytest-asyncio`` is not installed, so each async body runs under ``asyncio.run`` behind a plain
``def test_*``.
"""

from __future__ import annotations

import asyncio
import re

import pytest
from rich.console import Console
from textual.widgets import DataTable, Static

from shockbox_tui.app import (
    ConfirmScreen,
    ShockBoxApp,
    TAB_IDS,
    colour_line,
    coerce,
    fmt_uptime,
)

# ---- the fake ---------------------------------------------------------------------------

STATUS = {
    "state": "running",
    "pid": 4242,
    "node_pid": 5151,
    "port": 8972,
    "since": "2026-10-30T10:00:00",
    "restarts": 3,
    "last_error": None,
}
HEALTH = {
    "ok": True,
    "version": "2.0.0",
    "pid": 5151,
    "port": 8972,
    "uptime": 3725,
    "modules": {"wall": "ok", "notifications": "ok"},
    "obs": {"state": "connected", "scene": "Main"},
}
MODULES = [
    {"id": "wall", "status": "ok", "error": None},
    {"id": "notifications", "status": "ok", "error": None},
    {"id": "handfx", "status": "error", "error": "camera busy"},
]
WALL = {
    "ok": True,
    "seq": 4,
    "online": {"landscape": True, "portrait": False},
    "commands": ["blackout.toggle", "ratio.toggle"],
    "ratio": {"value": "16:9"},
    "settings": {
        "pattern": {"type": "enum", "label": "Pattern", "value": "synthwave", "values": ["synthwave", "lava"]},
        "brightness": {"type": "number", "label": "Brightness", "value": 80, "min": 0, "max": 100},
        "blackout": {"type": "bool", "label": "Blackout", "value": False},
    },
}
HAND_FX = {
    "effects": [
        {"id": "fireball", "title": "Fireball", "gesture": "open palm up"},
        {"id": "shoot", "title": "Shoot", "gesture": "point"},
    ],
    "settings": {"effects": {"type": "array", "value": ["fireball"]}, "skins": {"shoot": "projectile"}},
    "model": {"local": True},
    "runtime": {"vendored": True},
    "body": {"pageOpen": False},
    "isolation": {"crossOriginEmbedderPolicy": "require-corp"},
    "skins": ["projectile", "heart"],
}
SETTINGS = {
    "core": {
        "verbose": {"type": "bool", "label": "Verbose", "value": False},
        "pollMs": {"type": "number", "label": "Poll ms", "value": 500, "min": 100, "max": 5000},
        "mode": {"type": "enum", "label": "Mode", "value": "fast", "values": ["fast", "slow"]},
    },
    "config": {
        "port": 8972,
        "host": "127.0.0.1",
        "obs": {"url": "ws://127.0.0.1:4455", "enabled": True, "passwordSet": True, "password": "********"},
    },
}


class _FakeClient:
    """The read-only half of ApiClient: ``request(method, path)`` for the poller's GETs."""

    def __init__(self, control: "FakeControl"):
        self.control = control

    def request(self, method, path, body=None):
        self.control.calls.append(("client.request", (method, path), {}))
        if path.endswith("/audio/list"):
            return {"ok": True, "files": ["ding.wav", "boom.wav"], "available": True}
        return {"ok": True, "live": []}


class FakeControl:
    """Records calls; returns canned documents.

    ``fail_on`` maps a method name to an exception that method should raise, so a test can prove
    a failed action reads as failure rather than success.
    """

    def __init__(self, **overrides):
        self.calls: list[tuple] = []
        self.fail_on: dict[str, Exception] = {}
        self.status_doc = dict(STATUS)
        self.health_doc = dict(HEALTH)
        self.modules_doc = list(MODULES)
        self.wall_doc = dict(WALL)
        self.handfx_doc = dict(HAND_FX)
        self.settings_doc = dict(SETTINGS)
        self.log_lines = ["[10:00] server ready", "launcher: watching", "error: socket refused", "warn: slow"]
        # Read-only routes go through client.request, exactly as production does.
        self.client = _FakeClient(self)
        for key, value in overrides.items():
            setattr(self, key, value)

    def _record(self, name: str, *args, **kwargs):
        self.calls.append((name, args, kwargs))
        if name in self.fail_on:
            raise self.fail_on[name]

    # lifecycle
    def status(self):
        self._record("status")
        return dict(self.status_doc)

    def start(self):
        self._record("start")
        return {"state": "running"}

    def stop(self):
        self._record("stop")
        return {"state": "stopped"}

    def restart(self):
        self._record("restart")
        return {"state": "running", "restarts": 4}

    def shutdown(self):
        self._record("shutdown")
        return {"state": "stopped"}

    def tail_log(self, n=200, follow=False):
        self._record("tail_log", n, follow)
        return list(self.log_lines)

    def health(self):
        self._record("health")
        return dict(self.health_doc)

    def modules(self):
        self._record("modules")
        return list(self.modules_doc)

    def url(self):
        return "http://127.0.0.1:8972/"

    # settings
    def settings(self):
        self._record("settings")
        return self.settings_doc

    def patch(self, changes, module=None):
        self._record("patch", changes, module=module)
        return {"changed": list(changes), "needs_restart": False, "settings": {}}

    # wall
    def wall_live(self):
        self._record("wall_live")
        return dict(self.wall_doc)

    def wall_cmd(self, cmd, args=None):
        self._record("wall_cmd", cmd, args)
        return {"ok": True, "note": "delivered", "ratio": "9:16"}

    def wall_patch(self, changes):
        self._record("wall_patch", changes)
        return {"ok": True, "changed": list(changes)}

    # popups + hand fx
    def notify(self, path, body=None, method="POST"):
        self._record("notify", path, body, method)
        if path == "/audio/list":
            return {"ok": True, "files": ["ding.wav", "boom.wav"], "available": True}
        if method == "GET":
            return {"ok": True, "live": []}
        return {"ok": True, "entity": {"id": "n1"}}

    def dialog(self, path, body=None, method="POST"):
        self._record("dialog", path, body, method)
        if method == "GET":
            return {"ok": True, "count": 0}
        return {"ok": True}

    def handfx_status(self):
        self._record("handfx_status")
        return dict(self.handfx_doc)

    def handfx(self, cmd, args=None):
        self._record("handfx", cmd, args)
        return {"ok": True}

    def handfx_fire(self, skin=None):
        self._record("handfx_fire", skin)
        return {"ok": True}

    def handfx_skins(self):
        self._record("handfx_skins")
        return list(HAND_FX["skins"])




def calls_named(fake: FakeControl, name: str) -> list[tuple]:
    return [c for c in fake.calls if c[0] == name]


async def settle(pilot, ticks: int = 4) -> None:
    """Poll once, then let the message pump drain so the paint callback lands."""
    for _ in range(ticks):
        pilot.app._poll_now()
        await pilot.pause(0.05)


async def wait_for(pilot, predicate, attempts: int = 60) -> bool:
    """Wait until ``predicate()`` is true, pumping frames with an awaited pause."""
    for _ in range(attempts):
        if predicate():
            return True
        await pilot.pause(0.05)
    return bool(predicate())


def widget_text(app: ShockBoxApp, selector: str) -> str:
    """A Static's *rendered* text: Rich markup parsed, so only what is on screen counts."""
    from rich.console import Console

    widget = app.query_one(selector, Static)
    content = widget.content
    console = Console(width=400, record=True, file=open("/dev/null", "w"))
    console.print(content)
    return console.export_text()


def screen_text(app: ShockBoxApp) -> str:
    """The whole screen as text: every Static's rendered content plus the tables' visible cells."""
    parts = [widget_text(app, "#status"), widget_text(app, "#footer-line")]
    for table_id in ("#modules-table", "#wall-table", "#settings-server", "#settings-config"):
        try:
            table = app.query_one(table_id, DataTable)
        except Exception:  # noqa: BLE001 - not composed yet
            continue
        for row_key in list(table.rows):
            row = table.get_row(row_key)
            parts += [str(cell) for cell in row]
    return "\n".join(str(p) for p in parts if p)


def footer_text(app: ShockBoxApp) -> str:
    """The footer's rendered line — the only place an outcome is reported.

    The Static is full-width, so its trailing padding is stripped; assertions compare the text
    the operator reads, not the spaces that fill the row.
    """
    return widget_text(app, "#footer-line").rstrip()


# ---- pure helpers -----------------------------------------------------------------------


def test_coerce_rejects_bad_number_and_bad_enum():
    number, error = coerce("number", "abc", {"min": 0, "max": 100})
    assert number is None
    assert error and "not a number" in error

    number, error = coerce("number", "150", {"min": 0, "max": 100})
    assert number is None
    assert error and "above the maximum" in error

    enum, error = coerce("enum", "purple", {"values": ["fast", "slow"]})
    assert enum is None
    assert error and "not one of" in error

    ok, error = coerce("number", "42", {"min": 0, "max": 100})
    assert (ok, error) == (42, None)

    ok, error = coerce("bool", "true")
    assert (ok, error) == (True, None)


def test_colour_line_wraps_without_changing_text():
    line = "error: socket refused [core]"
    coloured = colour_line(line)
    assert coloured != line  # it did colour
    assert "red" in coloured
    # Unescape + strip only the wrapper tags: the original text must be byte-identical.
    stripped = re.sub(r"^\[[a-z ]+\]", "", coloured)
    stripped = re.sub(r"\[/[a-z ]+\]$", "", stripped).replace("\\[", "[")
    assert stripped == line, stripped
    assert colour_line("plain line") == "plain line"


def test_fmt_uptime():
    assert fmt_uptime(45) == "45s"
    assert fmt_uptime(125) == "2m05s"
    assert fmt_uptime(3725) == "1h02m"
    assert fmt_uptime(None) == "0s"


# ---- the app ----------------------------------------------------------------------------


def _app(fake: FakeControl | None = None, poll: float = 0.2) -> ShockBoxApp:
    return ShockBoxApp(fake or FakeControl(), poll=poll)


def test_app_mounts_with_all_seven_tabs():
    async def body() -> None:
        async with _app().run_test(size=(140, 45)) as pilot:
            await settle(pilot)
            panes = {pane.id for pane in pilot.app.query("TabPane")}
            assert set(TAB_IDS) <= panes, panes

    asyncio.run(body())


def test_status_bar_shows_running_and_node_pid():
    async def body() -> None:
        async with _app().run_test(size=(140, 45)) as pilot:
            await settle(pilot)
            rendered = screen_text(pilot.app)
            assert "RUNNING" in rendered
            assert "5151" in rendered  # node pid from the fake status

    asyncio.run(body())


def test_ratio_button_calls_wall_cmd_once():
    async def body() -> None:
        fake = FakeControl()
        async with _app(fake).run_test(size=(140, 45)) as pilot:
            await settle(pilot)
            fake.calls.clear()
            await pilot.click("#tab-wall")
            await settle(pilot)
            await pilot.click("#wall-ratio-btn")
            await settle(pilot)
            sent = calls_named(fake, "wall_cmd")
            assert len(sent) == 1, sent
            assert sent[0][1] == ("ratio.toggle", None)  # one command, no args
            footer = footer_text(pilot.app)
            assert "wall.ratio.toggle" in footer
            assert "failed" not in footer

    asyncio.run(body())


def test_failed_action_reports_failure_and_not_success():
    async def body() -> None:
        fake = FakeControl()
        fake.fail_on["wall_cmd"] = RuntimeError("HTTP 503: engine offline")
        async with _app(fake).run_test(size=(140, 45)) as pilot:
            await settle(pilot)
            await pilot.click("#tab-wall")
            await settle(pilot)
            await pilot.click("#wall-ratio-btn")
            # The action runs on a thread; wait for the footer to leave "…".
            await wait_for(pilot, lambda: "…" not in footer_text(pilot.app))
            footer = footer_text(pilot.app)
            assert "failed" in footer, footer
            assert "HTTP 503" in footer
            assert "wall.ratio.toggle: failed" in footer
            assert ": done" not in footer

    asyncio.run(body())


def test_overview_module_table_has_one_row_per_module():
    async def body() -> None:
        fake = FakeControl()
        async with _app(fake).run_test(size=(140, 45)) as pilot:
            await settle(pilot)
            table = pilot.app.query_one("#modules-table")
            assert table.row_count == len(MODULES)

    asyncio.run(body())


def test_toggling_boolean_setting_row_patches_with_module():
    async def body() -> None:
        fake = FakeControl()
        async with _app(fake).run_test(size=(140, 45)) as pilot:
            await settle(pilot)
            fake.calls.clear()
            await pilot.click("#tab-settings")
            await settle(pilot)
            # Drive the row handler directly: clicking a specific DataTable row by coordinate is
            # brittle, and the handler is the unit that decides what gets sent.
            table = pilot.app.query_one("#settings-server")
            row_key = None
            for key in table.rows:
                if key.value == "core:verbose":
                    row_key = key
            assert row_key is not None, list(table.rows)
            event = type("Ev", (), {"data_table": table, "row_key": row_key})()
            pilot.app.on_data_table_row_selected(event)
            await wait_for(pilot, lambda: calls_named(fake, "patch"))
            patched = calls_named(fake, "patch")
            assert len(patched) == 1, patched
            changes, kwargs = patched[0][1], patched[0][2]
            assert changes == ({"verbose": True},), changes
            assert kwargs.get("module") is None  # core

    asyncio.run(body())


def test_handfx_apply_sends_selected_effect_ids():
    async def body() -> None:
        fake = FakeControl()
        async with _app(fake).run_test(size=(140, 45)) as pilot:
            await settle(pilot)
            fake.calls.clear()
            await pilot.click("#tab-handfx")
            await settle(pilot)
            listing = pilot.app.query_one("#handfx-list")
            assert listing.option_count == len(HAND_FX["effects"])
            await pilot.click("#handfx-apply")
            await wait_for(pilot, lambda: calls_named(fake, "handfx"))
            sent = calls_named(fake, "handfx")
            assert sent, "effect.set was not sent"
            assert sent[0][1] == ("effect.set", {"value": ["fireball"]})

    asyncio.run(body())


def test_log_pane_receives_lines_and_colour_does_not_alter_text():
    async def body() -> None:
        fake = FakeControl()
        async with _app(fake).run_test(size=(140, 45)) as pilot:
            await settle(pilot)
            await pilot.click("#tab-log")
            await settle(pilot)
            app = pilot.app
            # What landed in the pane is exactly the file's lines, once each.
            assert set(fake.log_lines) <= set(app._log_lines)
            # Each stored line is the file's own text; colouring is applied only at write time.
            for line in fake.log_lines:
                # Remove only the wrapper the function adds; the line's own brackets must survive.
                stripped = colour_line(line)
                if stripped != line:
                    stripped = re.sub(r"^\[[a-z ]+\]", "", stripped)
                    stripped = re.sub(r"\[/[a-z ]+\]$", "", stripped)
                stripped = stripped.replace("\\[", "[")
                assert stripped == line, (line, stripped)

    asyncio.run(body())


def test_shutdown_button_needs_confirmation():
    async def body() -> None:
        fake = FakeControl()
        async with _app(fake).run_test(size=(140, 45)) as pilot:
            await settle(pilot)
            fake.calls.clear()
            await pilot.click("#btn-shutdown")
            await settle(pilot)
            assert isinstance(pilot.app.screen, ConfirmScreen)
            assert not calls_named(fake, "shutdown")
            await pilot.press("escape")
            await settle(pilot)
            assert not isinstance(pilot.app.screen, ConfirmScreen)
            assert not calls_named(fake, "shutdown")

    asyncio.run(body())


def test_layout_renders_and_exports_screenshot(tmp_path):
    async def body() -> str:
        async with _app().run_test(size=(140, 45)) as pilot:
            await settle(pilot)
            svg = pilot.app.export_screenshot()
            assert svg.startswith("<?xml") or svg.lstrip().startswith("<svg"), svg[:80]
            return svg

    svg = asyncio.run(body())
    out = tmp_path / "shockbox.svg"
    out.write_text(svg, encoding="utf-8")
    assert out.stat().st_size > 1000
    assert "ShockBox" in svg or "Overview" in svg


# ---- narrow fixes: server-answered footers, guarded handlers ----------------------------


def test_open_browser_raising_url_reports_red_and_does_not_crash():
    """``url()`` is resolved inside the guarded path; a raise lands in the red footer."""

    async def body() -> tuple[str, int]:
        fake = FakeControl()

        def boom():
            raise RuntimeError("config.json is unreadable")

        fake.url = boom  # type: ignore[method-assign]
        async with _app(fake).run_test(size=(140, 45)) as pilot:
            await settle(pilot)
            await pilot.click("#btn-open")
            await wait_for(pilot, lambda: "…" not in footer_text(pilot.app))
            assert pilot.app.return_code is None  # the app did not die
            return footer_text(pilot.app), len(calls_named(fake, "open"))

    footer, _ = asyncio.run(body())
    assert footer == "open browser: failed — config.json is unreadable", footer


def test_open_browser_success_uses_the_server_url():
    async def body() -> str:
        fake = FakeControl()
        async with _app(fake).run_test(size=(140, 45)) as pilot:
            await settle(pilot)
            import shockbox_tui.app as appmod

            original = appmod.webbrowser.open
            appmod.webbrowser.open = lambda url: url  # type: ignore[assignment]
            try:
                await pilot.click("#btn-open")
                await wait_for(pilot, lambda: "…" not in footer_text(pilot.app))
            finally:
                appmod.webbrowser.open = original  # type: ignore[assignment]
            return footer_text(pilot.app)

    footer = asyncio.run(body())
    assert footer == "open browser: ok — opened http://127.0.0.1:8972/", footer


def test_handfx_skin_cycle_claims_only_what_the_server_confirms():
    """Green requires a live status read; the note names the server's own skin list."""

    async def body() -> tuple[str, int]:
        fake = FakeControl()
        async with _app(fake).run_test(size=(140, 45)) as pilot:
            await settle(pilot)
            fake.calls.clear()
            await pilot.click("#tab-handfx")
            await settle(pilot)
            await pilot.click("#handfx-skin")
            await wait_for(pilot, lambda: "…" not in footer_text(pilot.app))
            return footer_text(pilot.app), len(calls_named(fake, "handfx_status"))

    footer, status_reads = asyncio.run(body())
    assert status_reads >= 1, "skin cycle must read handfx_status before claiming anything"
    assert footer == "handfx.skin: ok — skin set locally: heart (server skins: projectile, heart)", footer
    assert "skin set locally" in footer


def test_handfx_skin_cycle_rejects_a_skin_the_server_lacks():
    """A candidate the live status does not list is a red failure, not a silent switch."""

    async def body() -> str:
        fake = FakeControl()
        fake.handfx_doc = dict(HAND_FX)
        fake.handfx_doc["skins"] = ["projectile"]  # server has one skin
        async with _app(fake).run_test(size=(140, 45)) as pilot:
            await settle(pilot)
            # Drive the handler with a stale local list, the way a long-open window could hold
            # one: the poll would otherwise re-sync it before the click lands.
            pilot.app._handfx_skins = ["projectile", "heart"]
            pilot.app._handfx_skin = "projectile"
            pilot.app._handfx_skin_cycle()
            await wait_for(pilot, lambda: "…" not in footer_text(pilot.app))
            return footer_text(pilot.app)

    footer = asyncio.run(body())
    assert footer == "handfx.skin: failed — server does not offer skin 'heart' (has: projectile)", footer


def test_dialog_show_reports_server_error_not_a_local_count():
    """A refusal from the server is red and quotes the server's own message."""

    async def body() -> str:
        fake = FakeControl()
        fake.fail_on["dialog"] = RuntimeError('HTTP 409: {"ok":false,"error":"too many dialogs"}')
        async with _app(fake).run_test(size=(140, 45)) as pilot:
            await settle(pilot)
            await pilot.click("#tab-dialogs")
            await settle(pilot)
            await pilot.click("#dialog-show")
            await wait_for(pilot, lambda: "…" not in footer_text(pilot.app))
            return footer_text(pilot.app)

    footer = asyncio.run(body())
    assert footer.startswith("dialogs.show: failed — HTTP 409"), footer
    assert "too many dialogs" in footer


def test_dialog_show_reports_ok_false_without_counting_locally():
    async def body() -> str:
        fake = FakeControl()

        def refused(path, body=None, method="POST"):
            fake.calls.append(("dialog", (path, body, method), {}))
            return {"ok": False, "error": "the dialog stack is full"}

        fake.dialog = refused  # type: ignore[method-assign]
        async with _app(fake).run_test(size=(140, 45)) as pilot:
            await settle(pilot)
            await pilot.click("#tab-dialogs")
            await settle(pilot)
            await pilot.click("#dialog-show")
            await wait_for(pilot, lambda: "…" not in footer_text(pilot.app))
            return footer_text(pilot.app)

    footer = asyncio.run(body())
    assert footer == "dialogs.show: failed — the dialog stack is full", footer
    assert "shown" not in footer


def test_dialog_show_reports_the_server_count_when_it_sends_one():
    async def body() -> str:
        fake = FakeControl()

        def spawns(path, body=None, method="POST"):
            fake.calls.append(("dialog", (path, body, method), {}))
            return {"ok": True, "spawned": 7}

        fake.dialog = spawns  # type: ignore[method-assign]
        async with _app(fake).run_test(size=(140, 45)) as pilot:
            await settle(pilot)
            await pilot.click("#tab-dialogs")
            await settle(pilot)
            await pilot.click("#dialog-show")
            await wait_for(pilot, lambda: "…" not in footer_text(pilot.app))
            return footer_text(pilot.app)

    footer = asyncio.run(body())
    assert footer == "dialogs.show: ok — spawned 7", footer


def test_dialogs_pane_paints_the_live_count():
    """The polled GET /api/dialogs/live is no longer fetched and discarded."""

    async def body() -> tuple[str, int]:
        fake = FakeControl()

        def request(method, path, body=None):
            fake.calls.append(("client.request", (method, path), {}))
            if path.endswith("/dialogs/live"):
                return {"ok": True, "live": [{"id": "dch_1"}, {"id": "dch_2"}]}
            return {"ok": True, "live": []}

        fake.client.request = request  # type: ignore[method-assign]
        async with _app(fake).run_test(size=(140, 45)) as pilot:
            await settle(pilot)
            await pilot.click("#tab-dialogs")
            await settle(pilot)
            return widget_text(pilot.app, "#dialog-status"), len(calls_named(fake, "client.request"))

    text, reads = asyncio.run(body())
    assert "2 open" in text, text
    assert "dch_1" in text
    assert reads >= 1


def test_main_refuses_a_deploy_folder_as_the_app_dir(tmp_path, capsys):
    """``--app-dir`` is the folder holding server.mjs, never its deploy\\ subfolder.

    deploy\\ShockBox-TUI.cmd passed ``%APP%\\deploy`` once: the app dir became deploy/, the
    server.mjs check failed, and the shortcut printed "no server.mjs" and exited 2 — a TUI that
    could never start the server. The .cmd passes %APP% now; this pins the guard that says so.
    """
    from shockbox_tui.app import main

    app = tmp_path / "ShockBox"
    (app / "deploy").mkdir(parents=True)
    (app / "server.mjs").write_text("// real app dir only\n", encoding="utf-8")

    assert main(["--app-dir", str(app / "deploy"), "--no-start"]) == 2
    err = capsys.readouterr().err
    assert "no server.mjs" in err
    assert str(app / "deploy") in err


def test_apply_with_nothing_selected_refuses_and_sends_nothing():
    """An empty effect.set would clear every effect; it must be refused, not sent."""

    async def body() -> tuple[str, int]:
        fake = FakeControl()
        async with _app(fake).run_test(size=(140, 45)) as pilot:
            await settle(pilot)
            await pilot.click("#tab-handfx")
            await settle(pilot)
            pilot.app.query_one("#handfx-list").deselect_all()
            fake.calls.clear()
            await pilot.click("#handfx-apply")
            await wait_for(pilot, lambda: True, attempts=6)
            return footer_text(pilot.app), len(calls_named(fake, "handfx"))

    footer, sent = asyncio.run(body())
    assert sent == 0, "effect.set must not be sent for an empty selection"
    assert footer == "handfx.effect.set: pick an effect first", footer
