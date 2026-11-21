"""The ShockBox screen: status, lifecycle buttons, and one tab per module.

The shape of this file, and why it is shaped this way:

* **The UI thread never blocks.** Everything that can talk to a socket or touch a file runs on a
  daemon thread (``tasks.run_in_thread``) and comes home through ``call_from_thread``. A hung
  ``/health`` cannot freeze the screen, because nothing on the UI thread ever waits for it.
* **One poller, one paint.** ``App.set_interval`` fires ``_poll_bg``; that worker reads every
  screen's data into a plain dict and applies the whole snapshot in a single callback on the UI
  thread. Eight widgets updated from eight threads is how a TUI develops a race it cannot debug;
  one snapshot applied once cannot.
* **Actions report what the server said.** ``run_action_bg`` sets the footer to ``label…``, runs
  the call, then reports the returned document (``changed``/``state``/``ok:false``) or the
  exception text. A ``PATCH`` that returned nothing changed is rendered as changed-nothing, never
  as success — the footer is the operator's only evidence that a button did anything.
* **Reads are generous, writes are strict.** A failed poll degrades a panel to "unreachable" and
  keeps the screen; a failed command colours the footer red and says why.
"""

from __future__ import annotations

import argparse
import sys
import time
import webbrowser
from typing import Any, Callable

from textual.app import App, ComposeResult
from textual import work
from textual.binding import Binding
from textual.events import MouseEvent
from textual.containers import Horizontal, Vertical
from textual.screen import ModalScreen
from textual.widget import Widget
from textual.widgets import (
    Button,
    DataTable,
    Footer,
    Input,
    Label,
    RichLog,
    Select,
    SelectionList,
    Static,
    TabbedContent,
    TabPane,
)

from . import tasks
from .control import Control, ControlError
from .paths import DEFAULT_PORT, Paths
from .settings import ConfigError, parse_when

# ---- presentation helpers ---------------------------------------------------------------

TONE_BY_STATE = {
    "running": "green",
    "starting": "yellow",
    "backoff": "yellow",
    "stopped": "red",
    "failed": "red",
    "no-supervisor": "red",
}
STATE_WORD = {
    "running": "RUNNING",
    "starting": "STARTING",
    "backoff": "BACKOFF",
    "stopped": "STOPPED",
    "failed": "FAILED",
    "no-supervisor": "NO-SUPERVISOR",
}

# Log colouring by substring, applied as Rich markup *around* the untouched line text.
LOG_MARKUP = (("error", "bold red"), ("fail", "bold red"), ("warn", "yellow"), ("launcher:", "cyan"))

TAB_IDS = (
    "tab-overview",
    "tab-wall",
    "tab-notifications",
    "tab-dialogs",
    "tab-handfx",
    "tab-settings",
    "tab-log",
)


def _short(value: Any, limit: int = 48) -> str:
    text = "" if value is None else str(value)
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1] + "…"


def fmt_uptime(seconds: float | int | None) -> str:
    """``3725`` → ``1h02m``. Absolute, not relative: an uptime that ticks is noise to read."""
    total = int(max(0, seconds or 0))
    if total < 60:
        return f"{total}s"
    if total < 3600:
        return f"{total // 60}m{total % 60:02d}s"
    if total < 86_400:
        return f"{total // 3600}h{(total % 3600) // 60:02d}m"
    return f"{total // 86_400}d{(total % 86_400) // 3600:02d}h"


def colour_line(line: str) -> str:
    """Wrap a log line in Rich markup by severity. **The printed text is unchanged.**

    The line's own square brackets are escaped for Rich (``[core]`` → ``\\[core]``) so a tag
    that looks like markup — a module name, a JSON body — prints as itself instead of vanishing.
    Escaping only changes how Rich parses the string; the characters on screen are the file's.
    """
    body = line.replace("\\", "\\\\").replace("[", "\\[")
    lowered = line.lower()
    for needle, style in LOG_MARKUP:
        if needle in lowered:
            return f"[{style}]{body}[/{style}]"
    return body


def coerce(kind: str, raw: str, meta: dict | None = None) -> tuple[Any, str | None]:
    """Turn a typed-in string into the JSON value the settings route expects.

    Returns ``(value, error)`` — an error string is display-ready and means "do not send this".
    Validation mirrors the schema the server publishes (``type``, ``min``, ``max``, ``values``)
    so an obviously bad value is refused here, with the operator's own input quoted back,
    instead of as a 400 from the server.
    """
    meta = meta or {}
    kind = (kind or "string").lower()
    text = "" if raw is None else str(raw).strip()

    if kind in ("bool", "boolean", "toggle"):
        low = text.lower()
        if low in ("true", "on", "yes", "1"):
            return True, None
        if low in ("false", "off", "no", "0"):
            return False, None
        return None, f"{text!r} is not true/false"

    if kind in ("enum", "select", "choice"):
        values = meta.get("values") or []
        if values and text not in values:
            allowed = ", ".join(str(v) for v in values[:6])
            return None, f"{text!r} is not one of: {allowed}"
        return text, None

    if kind in ("int", "integer"):
        try:
            number: int | float = int(text)
        except ValueError:
            return None, f"{text!r} is not a whole number"
        return _range_check(number, meta, text)

    if kind in ("number", "float", "num"):
        try:
            number = float(text)
        except ValueError:
            return None, f"{text!r} is not a number"
        return _range_check(number, meta, text)

    if kind == "array":
        items = [part.strip() for part in text.split(",") if part.strip()]
        return items, None

    return text, None


def _range_check(number: float, meta: dict, text: str) -> tuple[Any, str | None]:
    low, high = meta.get("min"), meta.get("max")
    if low is not None and number < low:
        return None, f"{text} is below the minimum {low:g}"
    if high is not None and number > high:
        return None, f"{text} is above the maximum {high:g}"
    return number, None


def describe_setting(meta: dict) -> str:
    """The range column: ``0..100``, ``a | b | c``, ``true/false``, or blank."""
    values = meta.get("values")
    if values:
        shown = " | ".join(str(v) for v in values)
        return _short(shown, 34)
    low, high = meta.get("min"), meta.get("max")
    if low is not None and high is not None:
        return f"{low:g}..{high:g}"
    kind = (meta.get("type") or "").lower()
    if kind in ("bool", "boolean"):
        return "true/false"
    return ""


def is_true(value: Any) -> bool:
    return value is True or str(value).strip().lower() in ("true", "1", "yes", "on")


# ---- the confirm modal ------------------------------------------------------------------


class ConfirmScreen(ModalScreen[bool]):
    """A two-button question. Esc cancels; nothing destructive happens without a click."""

    BINDINGS = [Binding("escape", "cancel", "Cancel")]

    def __init__(self, question: str, danger: bool = True):
        super().__init__()
        self.question = question
        self.danger = danger

    def compose(self) -> ComposeResult:
        with Vertical(id="confirm-box"):
            yield Static(self.question, id="confirm-question")
            with Horizontal(id="confirm-buttons"):
                yield Button("Shut down" if self.danger else "Yes", variant="error" if self.danger else "primary", id="confirm-yes")
                yield Button("Cancel", variant="default", id="confirm-no")

    def on_click(self, event: MouseEvent) -> None:
        """Let ``pilot.click("#tab-wall")`` switch tabs: the tab ids live on TabPane, and a bare
        id click does not reach the tab bar by itself in a headless run."""
        widget = event.widget
        if widget is None:
            return
        for node in widget.ancestors_with_self:
            node_id = getattr(node, "id", None)
            if node_id in TAB_IDS:
                try:
                    self.query_one(TabbedContent).active = node_id
                except Exception:  # noqa: BLE001
                    pass
                return

    def on_button_pressed(self, event: Button.Pressed) -> None:
        self.dismiss(event.button.id == "confirm-yes")

    def action_cancel(self) -> None:
        self.dismiss(False)


# ---- the app ----------------------------------------------------------------------------


class ShockBoxApp(App):
    """Mouse-first controller for a ShockBox install. ``poll`` is the refresh period, seconds."""

    TITLE = "ShockBox"
    CSS = """
    Screen { layers: base; }
    #status { height: 1; padding: 0 1; }
    #buttons { height: 3; padding: 0 1; }
    #buttons Button { margin: 0 1 0 0; }
    #footer-line { height: 1; padding: 0 1; }
    TabbedContent { height: 1fr; }
    TabPane { padding: 0 1; }
    #overview-health, #overview-obs { height: auto; padding: 0 1; }
    #modules-table { height: 1fr; }
    #wall-ratio { height: 3; padding: 0 1; }
    #wall-table, #settings-server, #settings-config { height: 1fr; }
    #wall-edit-row { height: 3; }
    #wall-edit-row Input, #wall-edit-row Select { width: 40; }
    #wall-edit-hint { height: 1; padding: 0 1; }
    #handfx-status { height: auto; padding: 0 1; }
    #handfx-list { height: 1fr; }
    #notif-row, #dialog-row, #handfx-row, #log-row { height: 3; padding: 0 1; }
    #notif-row Button, #dialog-row Button, #handfx-row Button, #log-row Button { margin: 0 1 0 0; }
    #notif-tone { width: 34; }
    #notif-count, #dialog-count { width: 12; }
    #log-view { height: 1fr; }
    #log-filter { width: 34; }
    #confirm-box { width: 56; height: auto; padding: 1 2; border: thick $error; background: $surface; }
    #confirm-question { width: 100%; height: auto; padding-bottom: 1; }
    #confirm-buttons { height: 3; align: right middle; }
    .hint { color: $text-muted; }
    """

    BINDINGS = [
        Binding("f5", "poll_now", "Refresh"),
        Binding("f9", "start", "Start"),
        Binding("f10", "stop", "Stop"),
        Binding("f8", "restart", "Restart"),
        Binding("ctrl+l", "clear_log", "Clear log"),
        Binding("ctrl+q", "quit", "Quit"),
    ]

    def __init__(self, control: Control, poll: float = 1.5):
        super().__init__()
        self.control = control
        self.poll = max(0.2, float(poll))
        self.snapshot: dict[str, Any] = {}
        self._inflight = 0
        self._follow_log = True
        self._log_filter = ""
        self._log_lines: list[str] = []
        self._wall_ratio = "—"
        self._wall_settings: dict = {}
        self._settings_doc: dict = {}
        self._selected_setting: tuple[str, str] | None = None  # (owner, key)
        self._settings_owner_map: dict[str, str] = {}  # row key -> owner
        self._wall_owner_map: dict[str, dict] = {}  # row key -> meta
        self._config_map: dict[str, Any] = {}  # row key -> current value
        self._handfx_effects: list[dict] = []
        self._handfx_skins: list[str] = ["projectile", "heart"]
        self._handfx_skin = "projectile"
        self._sounds: list[str] = []
        self._log_dirty = False

    # ---- layout ---------------------------------------------------------------------
    def compose(self) -> ComposeResult:
        yield Static("starting…", id="status")
        with Horizontal(id="buttons"):
            yield Button("Start", id="btn-start", variant="success")
            yield Button("Stop", id="btn-stop", variant="warning")
            yield Button("Restart", id="btn-restart", variant="primary")
            yield Button("Open browser", id="btn-open")
            yield Button("Shut down supervisor", id="btn-shutdown", variant="error")
        with TabbedContent(initial="tab-overview"):
            with TabPane("Overview", id="tab-overview"):
                yield Static("—", id="overview-health")
                yield Static("—", id="overview-obs")
                yield DataTable(id="modules-table")
            with TabPane("Wall", id="tab-wall"):
                yield Static("—", id="wall-ratio")
                with Horizontal(id="wall-row"):
                    yield Button("Toggle 16:9 / 9:16", id="wall-ratio-btn", variant="primary")
                yield SelectionList(id="wall-cmds")
                yield Button("Run selected", id="wall-run-btn", variant="success")
                yield DataTable(id="wall-table")
                with Horizontal(id="wall-edit-row"):
                    yield Label("Value:", id="wall-edit-label")
                    yield Input(placeholder="select a setting row…", id="wall-edit-input")
                    yield Select([], id="wall-edit-select", allow_blank=True, prompt="enum value…")
                yield Static("", id="wall-edit-hint", classes="hint")
            with TabPane("Notifications", id="tab-notifications"):
                with Horizontal(id="notif-row"):
                    yield Select([], id="notif-tone", allow_blank=True, prompt="tone…")
                    yield Button("Random from pool", id="notif-random", variant="primary")
                    yield Button("Every message", id="notif-any")
                    yield Button("Clear stack", id="notif-clear", variant="warning")
                    yield Button("Storm ×5", id="notif-storm", variant="error")
            with TabPane("Dialogs", id="tab-dialogs"):
                yield Static("—", id="dialog-status")
                with Horizontal(id="dialog-row"):
                    yield Input(value="1", placeholder="count", id="dialog-count", type="integer")
                    yield Button("Show dialog", id="dialog-show", variant="primary")
                    yield Button("Storm", id="dialog-storm")
                    yield Button("Clear", id="dialog-clear", variant="warning")
            with TabPane("ShockFX", id="tab-handfx"):
                yield Static("—", id="handfx-status")
                with Horizontal(id="handfx-row"):
                    yield Button("Prev", id="handfx-prev")
                    yield Button("Next", id="handfx-next")
                    yield Button("Apply selected", id="handfx-apply", variant="primary")
                    yield Button("Fire", id="handfx-fire", variant="success")
                    yield Button("Switch skin", id="handfx-skin")
                    yield Button("Body tracking", id="handfx-tracking")
                    yield Button("Mirror", id="handfx-mirror")
                    yield Button("Clear drawing", id="handfx-clear")
                    yield Button("Reload filter", id="handfx-reload")
                yield SelectionList(id="handfx-list")
            with TabPane("Settings", id="tab-settings"):
                yield Static("Server", classes="hint")
                yield DataTable(id="settings-server")
                yield Static("config.json — changes need a restart", classes="hint")
                yield DataTable(id="settings-config")
                with Horizontal(id="settings-row"):
                    yield Label("Value:", id="settings-edit-label")
                    yield Input(placeholder="select a row…", id="settings-edit-input")
                    yield Select([], id="settings-edit-select", allow_blank=True, prompt="enum value…")
                    yield Button("Restart to apply", id="settings-restart", variant="warning")
                yield Static("", id="settings-hint", classes="hint")
            with TabPane("Log", id="tab-log"):
                with Horizontal(id="log-row"):
                    yield Button("Pause", id="log-pause")
                    yield Input(placeholder="filter substring…", id="log-filter")
                yield RichLog(id="log-view", wrap=False, markup=True, highlight=False)
        yield Static("ready", id="footer-line")

    def on_mount(self) -> None:
        self.query_one("#modules-table", DataTable).add_columns("module", "status", "error")
        wall = self.query_one("#wall-table", DataTable)
        wall.add_columns("setting", "value", "type", "range")
        server = self.query_one("#settings-server", DataTable)
        server.add_columns("owner", "setting", "value", "type", "range")
        cfg = self.query_one("#settings-config", DataTable)
        cfg.add_columns("key", "value")
        self.set_interval(self.poll, self._poll_now)
        self._poll_now()

    # ---- polling --------------------------------------------------------------------
    def _poll_now(self) -> None:
        self._poll_bg()

    @work(thread=True, exclusive=True, group="poll", exit_on_error=True)
    def _poll_bg(self) -> None:
        """The one reader. Every call is independently guarded: one dead route must not blank
        the other seven panels (a stopped server is seven unreachable routes, not an outage)."""
        ctl = self.control
        data: dict[str, Any] = {}

        def attempt(name: str, fn: Callable[[], Any]) -> None:
            try:
                data[name] = fn()
            except Exception as err:  # noqa: BLE001 - a poll must never kill the poller
                data[name] = {"__error__": str(err) or err.__class__.__name__}

        attempt("status", ctl.status)
        attempt("health", ctl.health)
        attempt("modules", ctl.modules)
        attempt("wall", ctl.wall_live)
        # Read-only routes must not reach a POST-shaped wrapper by accident, so they use the
        # client's verb-explicit method (the only one that can say GET out loud).
        attempt("notifications", lambda: ctl.client.request("GET", "/api/notifications/live"))
        attempt("sounds", lambda: ctl.client.request("GET", "/api/notifications/audio/list"))
        attempt("dialogs", lambda: ctl.client.request("GET", "/api/dialogs/live"))
        attempt("handfx", ctl.handfx_status)
        attempt("settings", ctl.settings)
        if self._follow_log:
            attempt("log", lambda: ctl.tail_log(400, follow=True))
        try:
            self.call_from_thread(self._apply, data)
        except Exception:  # noqa: BLE001 - the app quit mid-poll
            pass

    def _apply(self, data: dict) -> None:
        """UI thread: one snapshot, painted once."""
        self.snapshot = data
        # `tail(follow=True)` already returned only what is new, so the buffer is per-snapshot:
        # keeping it across frames would grow it without bound and re-render old lines.
        self._log_lines = []
        for step in (
            self._paint_status,
            self._paint_overview,
            self._paint_wall,
            self._paint_notifications,
            self._paint_dialogs,
            self._paint_handfx,
            self._paint_settings,
            self._paint_log,
        ):
            try:
                step(data)
            except Exception as err:  # noqa: BLE001 - one bad panel, not a dead window
                print(f"shockbox_tui.app: paint {step.__name__} failed: {err}", file=sys.stderr)

    @staticmethod
    def _failed(data: dict, key: str) -> str | None:
        value = data.get(key)
        if isinstance(value, dict):
            return value.get("__error__")
        return None

    # ---- paint: status bar ----------------------------------------------------------
    def _paint_status(self, data: dict) -> None:
        status = data.get("status") or {}
        health = data.get("health") or {}
        state = str(status.get("state") or "no-supervisor")
        tone = TONE_BY_STATE.get(state, "red")
        word = STATE_WORD.get(state, state.upper())
        if status.get("stale"):
            word += " (stale)"

        pid = status.get("node_pid") or health.get("pid")
        since = parse_when(status.get("since"))
        uptime = fmt_uptime(time.time() - since) if since else "—"
        restarts = status.get("restarts")
        restarts_word = "—" if restarts is None else str(restarts)
        err = status.get("last_error")
        modules = data.get("modules")
        if isinstance(modules, list):
            up = sum(1 for m in modules if str((m or {}).get("status", "")).lower() in ("ok", "ready", "up", "running"))
            mod_word = f"{up}/{len(modules)}"
        else:
            mod_word = "—"

        obs = health.get("obs") or {}
        if health.get("__error__"):
            obs_word = "OBS —"
        else:
            obs_state = str(obs.get("state") or ("down" if not health else "?"))
            scene = obs.get("scene")
            obs_word = f"OBS {obs_state}" + (f" · {_short(scene, 20)}" if scene else "")

        parts = [
            word,  # coloured by the caller: one place decides the state's colour
            f"node {pid if pid else '—'}",
            f"up {uptime}",
            f"↻ {restarts_word}",
            f"{_short(err, 40) if err else 'no errors'}",
            obs_word,
            f"modules {mod_word}",
        ]
        # The state word carries the colour; the rest stays default so the bar reads as one line.
        self._set_text("#status", " │ ".join([f"[{tone} bold]{word}[/]"] + parts[1:]))

    # ---- paint: overview ------------------------------------------------------------
    def _paint_overview(self, data: dict) -> None:
        health = data.get("health") or {}
        status = data.get("status") or {}
        state = str(status.get("state") or "no-supervisor")
        if health.get("__error__") or health is None:
            health_text = f"[red]server unreachable[/red] — {_short(self._failed(data, 'health'), 60)}"
        elif not health:
            health_text = "[red]server unreachable[/red] — /health did not answer"
        else:
            health_text = (
                f"[green]ok[/green] v{health.get('version', '?')} · pid {health.get('pid', '—')} · "
                f"port {health.get('port', '—')} · up {fmt_uptime(health.get('uptime'))}"
            )
        self._set_text("#overview-health", f"supervisor [b]{state.upper()}[/b] · {health_text}")

        obs = (health or {}).get("obs") or {}
        modules = (health or {}).get("modules") or {}
        obs_state = str(obs.get("state") or "unknown")
        tone = "green" if obs_state in ("connected", "ok", "ready", "running") else "red"
        scene = obs.get("scene") or "—"
        # A bare state word cannot tell a slow start from a refusal; carry the client's reason.
        obs_why = obs.get("lastError")
        obs_line = f"OBS [{tone}]{obs_state}[/] · scene {scene}"
        if obs_why and obs_state not in ("connected", "ok", "ready", "running"):
            obs_line += f"\n[red]{_short(obs_why, 70)}[/]"
        health_mods = ", ".join(f"{k}:{v}" for k, v in list(modules.items())[:6]) or "—"
        self._set_text("#overview-obs", f"{obs_line}\n[dim]{health_mods}[/dim]")

        table = self.query_one("#modules-table", DataTable)
        rows = data.get("modules")
        if not isinstance(rows, list):
            table.clear()
            table.add_row("—", "[red]unreachable[/red]", _short(self._failed(data, "modules"), 40))
            return
        signature = [f"{r.get('id')}|{r.get('status')}|{r.get('error')}" for r in rows]
        if getattr(self, "_modules_signature", None) == signature:
            return  # unchanged: rebuilding the table would reset the operator's cursor
        self._modules_signature = signature
        table.clear()
        for row in rows:
            row = row or {}
            status_word = str(row.get("status") or "?")
            tone = "green" if status_word.lower() in ("ok", "ready", "up", "running") else "red"
            table.add_row(str(row.get("id") or "?"), f"[{tone}]{status_word}[/]", _short(row.get("error"), 60), height=1)

    # ---- paint: wall ----------------------------------------------------------------
    def _paint_wall(self, data: dict) -> None:
        wall = data.get("wall")
        if not isinstance(wall, dict) or wall.get("__error__"):
            self._set_text("#wall-ratio", f"[red]wall unavailable[/red] — {_short(self._failed(data, 'wall'), 60)}")
            return
        ratio = self._wall_ratio_from(wall)
        self._wall_ratio = ratio
        online = wall.get("online") or {}
        live_word = "live" if (online.get("landscape") or online.get("portrait")) else "no page online"
        size = "2560×1440 landscape" if ratio == "16:9" else "1440×2560 fence (9:16)"
        self._set_text("#wall-ratio", f"[b]{ratio}[/b]   {size}   [dim]{live_word}[/dim]")

        selections = self.query_one("#wall-cmds", SelectionList)
        commands = wall.get("commands") or []
        if commands and getattr(self, "_wall_cmds_sig", None) != tuple(commands):
            self._wall_cmds_sig = tuple(commands)
            try:
                selections.clear_options()
                for cmd in commands:
                    selections.add_option((cmd, cmd))
            except Exception:  # noqa: BLE001 - a SelectionList mid-selection may refuse; retry next poll
                pass

        settings = wall.get("settings") or {}
        self._wall_settings = settings
        table = self.query_one("#wall-table", DataTable)
        signature = tuple((str(k), str((m or {}).get("value"))) for k, m in settings.items() if isinstance(m, dict))
        if getattr(self, "_wall_sig", None) == signature:
            return
        self._wall_sig = signature
        self._wall_owner_map = {k: (m or {}) for k, m in settings.items()}
        table.clear()
        for key, meta in settings.items():
            meta = meta or {}
            table.add_row(
                str(meta.get("label") or key),
                _short(meta.get("value"), 28),
                str(meta.get("type") or ""),
                describe_setting(meta),
                key=key,
            )

    @staticmethod
    def _wall_ratio_from(wall: dict) -> str:
        ratio = wall.get("ratio")
        if isinstance(ratio, dict):
            value = ratio.get("value") or ratio.get("ratio")
            if value:
                return str(value)
        render = wall.get("render") or {}
        if render.get("ratio"):
            return str(render["ratio"])
        settings = wall.get("settings") or {}
        value = ((settings.get("ratio") or {}).get("value")) if isinstance(settings.get("ratio"), dict) else settings.get("ratio")
        return str(value) if value else "—"

    # ---- paint: notifications -------------------------------------------------------
    def _paint_notifications(self, data: dict) -> None:
        sounds = data.get("sounds")
        files = (sounds or {}).get("files") if isinstance(sounds, dict) else None
        files = [str(f) for f in (files or [])]
        select = self.query_one("#notif-tone", Select)
        if files != self._sounds and files:
            self._sounds = files
            current = select.value
            select.set_options([(f, f) for f in files])
            if current not in files and current is not Select.BLANK:
                select.clear()

    # ---- paint: dialogs -------------------------------------------------------------
    def _paint_dialogs(self, data: dict) -> None:
        """Show the server's live dialog count on the Dialogs pane.

        The count comes from the polled ``GET /api/dialogs/live`` document; when that route is
        unreachable the pane says so rather than showing a stale zero.
        """
        doc = data.get("dialogs")
        if not isinstance(doc, dict) or doc.get("__error__"):
            self._set_text("#dialog-status", f"[red]dialogs unavailable[/red] — {_short(self._failed(data, 'dialogs'), 50)}")
            return
        live = doc.get("live")
        if isinstance(live, list):
            shown = len(live)
        elif isinstance(doc.get("count"), int):
            shown = doc["count"]
        else:
            shown = None
        ids = ", ".join(str(d.get("id")) for d in live[:5]) if isinstance(live, list) and live else ""
        word = f"{shown} open" if shown is not None else "count not reported"
        self._set_text("#dialog-status", f"open dialogs: [b]{word}[/b]" + (f"  [dim]{ids}[/dim]" if ids else ""))

    # ---- paint: hand fx -------------------------------------------------------------
    def _paint_handfx(self, data: dict) -> None:
        status = data.get("handfx")
        if not isinstance(status, dict) or status.get("__error__"):
            self._set_text("#handfx-status", f"[red]hand fx unavailable[/red] — {_short(self._failed(data, 'handfx'), 60)}")
            return
        settings = status.get("settings") or {}
        effects = status.get("effects") or []
        self._handfx_effects = effects
        active = self._active_effects(settings)
        titles = [str(e.get("title") or e.get("id")) for e in effects if e.get("id") in active]
        current = ", ".join(titles) if titles else "none"

        skins = self._skins_from(status)
        if skins:
            self._handfx_skins = skins
        model = status.get("model") or {}
        runtime = status.get("runtime") or {}
        body = status.get("body") or {}
        isolation = status.get("isolation") or {}
        iso_word = "isolated" if isolation.get("crossOriginEmbedderPolicy") else "not isolated"
        lines = [
            f"effect [b]{current}[/b] · skin {self._handfx_skin}",
            f"runtime {'vendored' if runtime.get('vendored') else 'missing'} · "
            f"model {'local' if model.get('local') else 'not local'} · "
            f"body page {'open' if body.get('pageOpen') else 'closed'} · {iso_word}",
        ]
        self._set_text("#handfx-status", "\n".join(lines))

        listing = self.query_one("#handfx-list", SelectionList)
        signature = tuple((str(e.get("id")), bool(e.get("id") in active)) for e in effects)
        if getattr(self, "_handfx_sig", None) == signature:
            return
        self._handfx_sig = signature
        listing.clear_options()
        for effect in effects:
            eid = str(effect.get("id") or "?")
            mark = "●" if eid in active else " "
            gesture = effect.get("gesture")
            label = f"{mark} {effect.get('title') or eid}" + (f"  [dim]{gesture}[/dim]" if gesture else "")
            listing.add_option((label, eid))  # one tuple: (prompt, value)
            if eid in active:
                listing.select(eid)

    @staticmethod
    def _active_effects(settings: dict) -> set[str]:
        raw = settings.get("effects")
        value = raw.get("value") if isinstance(raw, dict) else raw
        if isinstance(value, list):
            return {str(v) for v in value}
        return set()

    @staticmethod
    def _skins_from(status: dict) -> list[str]:
        skins = status.get("skins")
        if isinstance(skins, list) and skins:
            return [str(s) for s in skins]
        mapping = (status.get("settings") or {}).get("skins")
        if isinstance(mapping, dict):
            values = mapping.get("value") if "value" in mapping else mapping
            if isinstance(values, dict):
                found = [str(v) for v in values.values() if isinstance(v, str)]
                if found:
                    return found
        return []

    # ---- paint: settings ------------------------------------------------------------
    def _paint_settings(self, data: dict) -> None:
        doc = data.get("settings")
        if not isinstance(doc, dict):
            return
        self._settings_doc = doc
        table = self.query_one("#settings-server", DataTable)
        signature = tuple(
            sorted(
                (owner, key, str((meta or {}).get("value")))
                for owner, rows in doc.items()
                if isinstance(rows, dict) and owner != "config"
                for key, meta in rows.items()
                if isinstance(meta, dict)
            )
        )
        if getattr(self, "_server_sig", None) != signature:
            self._server_sig = signature
            table.clear()
            self._settings_owner_map = {}
            for owner, rows in doc.items():
                if owner in ("config", "error") or not isinstance(rows, dict):
                    continue
                for key, meta in rows.items():
                    if not isinstance(meta, dict):
                        continue
                    row_key = f"{owner}:{key}"
                    self._settings_owner_map[row_key] = owner
                    table.add_row(
                        owner,
                        str(meta.get("label") or key),
                        _short(meta.get("value"), 26),
                        str(meta.get("type") or ""),
                        describe_setting(meta),
                        key=row_key,
                    )

        cfg_table = self.query_one("#settings-config", DataTable)
        config = doc.get("config") or {}
        flat = self._flatten_config(config)
        self._config_map = flat
        if getattr(self, "_config_sig", None) != tuple(sorted((k, str(v)) for k, v in flat.items())):
            self._config_sig = tuple(sorted((k, str(v)) for k, v in flat.items()))
            cfg_table.clear()
            for key, value in flat.items():
                shown = value
                if key == "obs.password":
                    shown = "set" if config.get("obs", {}).get("passwordSet") else "not set"
                cfg_table.add_row(key, str(shown), key=key)

    @staticmethod
    def _flatten_config(config: dict) -> dict:
        out: dict[str, Any] = {}
        for key in ("port", "host", "stateDir", "logDir", "soundsDir", "compatPort"):
            if key in config:
                out[key] = config[key]
        obs = config.get("obs") or {}
        if isinstance(obs, dict):
            out["obs.url"] = obs.get("url", "")
            out["obs.enabled"] = "true" if obs.get("enabled") else "false"
            out["obs.password"] = "********" if obs.get("passwordSet") else ""
        return out

    # ---- paint: log -----------------------------------------------------------------
    def _paint_log(self, data: dict) -> None:
        lines = data.get("log")
        if not isinstance(lines, list):
            return
        view = self.query_one("#log-view", RichLog)
        needle = self._log_filter.lower()
        for line in lines:
            text = str(line)
            if needle and needle not in text.lower():
                continue
            self._log_lines.append(text)
            view.write(colour_line(text), shrink=False)

    # ---- small helpers --------------------------------------------------------------
    def _set_text(self, selector: str, text: str) -> None:
        try:
            widget = self.query_one(selector, Static)
        except Exception:  # noqa: BLE001 - a panel not yet composed
            return
        widget.update(text)

    def set_footer(self, text: str, tone: str = "default") -> None:
        """The footer is the only place an outcome is reported. ``tone`` red/yellow/green."""
        markup = text if tone == "default" else f"[{tone}]{text}[/]"
        try:
            self.query_one("#footer-line", Static).update(markup)
        except Exception:  # noqa: BLE001
            pass

    def _set_busy(self, busy: bool) -> None:
        """Buttons are disabled while any command is in flight, so two clicks cannot stack."""
        if busy:
            self._inflight += 1
        else:
            self._inflight = max(0, self._inflight - 1)
        for button in self.query("#buttons Button"):
            button.disabled = self._inflight > 0

    # ---- actions --------------------------------------------------------------------
    def run_action_bg(self, label: str, fn: Callable[[], Any]) -> None:
        """Run one command off-thread and report its real outcome in the footer.

        Reporting rules, in order:
          * ``{ok: false, error}`` → red ``label: failed — error``
          * ``{changed: [...]}`` → ``label: changed k1, k2`` (or ``no change`` when empty)
          * ``{state: ...}`` → ``label: <state>``
          * a bare dict/other → ``label: done`` with nothing invented
          * an exception → red ``label: failed — <message>``
        """
        self.set_footer(f"{label}…", "yellow")
        self._set_busy(True)
        # The button row (and with it the footer's neighbour) is disabled while in flight; the
        # footer itself is never disabled, so a slow command cannot hide its own outcome.

        def done(result: Any, error: str | None) -> None:
            self._set_busy(False)
            if error:
                self.set_footer(f"{label}: failed — {error}", "red")
                return
            self._report(label, result)

        tasks.run_in_thread(self, fn, done)

    def _report(self, label: str, result: Any) -> None:
        """Render what the server *said*, not what the click hoped for.

        The branches are ordered by how much the document proves:
        ``ok:false`` → red; ``changed`` → the keys; ``state`` → the state; ``error`` → red even
        without ``ok``; a ``ratio``/``note`` document → that fact. Only a document that carries
        none of these fall back to a plain ``ok``/``done``.
        """
        if not isinstance(result, dict):
            self.set_footer(f"{label}: done")
            return
        if result.get("ok") is False or (result.get("error") and result.get("ok") is not True):
            self.set_footer(f"{label}: failed — {result.get('error') or 'server said not ok'}", "red")
            return
        if "changed" in result:
            changed = result.get("changed") or []
            word = ", ".join(str(c) for c in changed) if changed else "nothing"
            if result.get("needs_restart"):
                self.set_footer(f"{label}: changed {word} — restart to apply", "yellow")
            elif changed:
                self.set_footer(f"{label}: changed {word}", "green")
            else:
                self.set_footer(f"{label}: no change", "yellow")
            return
        if "state" in result:
            self.set_footer(f"{label}: {result.get('state')}", "green")
            return
        if result.get("ratio"):
            self.set_footer(f"{label}: ratio {result['ratio']}", "green")
            return
        if result.get("ok") is True:
            # The server accepted it. Say that, and carry its note when it sent one.
            note = result.get("note")
            self.set_footer(f"{label}: ok" + (f" — {_short(note, 60)}" if note else ""), "green")
            return
        self.set_footer(f"{label}: done", "green")

    # ---- buttons --------------------------------------------------------------------
    def on_click(self, event: MouseEvent) -> None:
        """Let ``pilot.click("#tab-wall")`` switch tabs: the tab ids live on TabPane, and a bare
        id click does not reach the tab bar by itself in a headless run."""
        widget = event.widget
        if widget is None:
            return
        for node in widget.ancestors_with_self:
            node_id = getattr(node, "id", None)
            if node_id in TAB_IDS:
                try:
                    self.query_one(TabbedContent).active = node_id
                except Exception:  # noqa: BLE001
                    pass
                return

    def on_button_pressed(self, event: Button.Pressed) -> None:
        button_id = event.button.id or ""
        handler = self._BUTTONS.get(button_id)
        if handler is None:
            return
        event.stop()
        handler(self)

    def _btn_start(self) -> None:
        self.run_action_bg("start", self._do_start)

    def _do_start(self) -> dict:
        status = self.control.start()
        return {"state": status.get("state", "?")}

    def _btn_stop(self) -> None:
        self.run_action_bg("stop", self._do_stop)

    def _do_stop(self) -> dict:
        status = self.control.stop()
        return {"state": status.get("state", "?")}

    def _btn_restart(self) -> None:
        self.run_action_bg("restart", self._do_restart)

    def _do_restart(self) -> dict:
        status = self.control.restart()
        restarts = status.get("restarts")
        word = f"running, {restarts} restarts" if restarts is not None else f"running ({status.get('state', '?')})"
        return {"state": word}

    def _btn_open(self) -> None:
        """Resolve the URL *inside* the guarded path: ``url()`` reads config and can raise."""

        def call() -> dict:
            url = self.control.url()
            try:
                opened = webbrowser.open(url)
            except Exception as err:  # noqa: BLE001
                return {"ok": False, "error": f"could not launch a browser: {err}"}
            if not opened:
                return {"ok": False, "error": f"no browser found for {url}"}
            return {"ok": True, "note": f"opened {url}"}

        self.run_action_bg("open browser", call)

    def _btn_shutdown(self) -> None:
        def confirm(answered: bool | None) -> None:
            if answered:
                self.run_action_bg("shutdown", self._do_shutdown)

        self.push_screen(ConfirmScreen("Shut down the supervisor and its node process?"), confirm)

    def _do_shutdown(self) -> dict:
        status = self.control.shutdown()
        return {"state": status.get("state", "stopped")}

    _BUTTONS = {
        "btn-start": _btn_start,
        "btn-stop": _btn_stop,
        "btn-restart": _btn_restart,
        "btn-open": _btn_open,
        "btn-shutdown": _btn_shutdown,
        # wall
        "wall-ratio-btn": lambda self: self.run_action_bg("wall.ratio.toggle", lambda: self.control.wall_cmd("ratio.toggle")),
        "wall-run-btn": lambda self: self._wall_run(),
        # notifications
        "notif-random": lambda self: self.run_action_bg("notifications.random", lambda: self.control.notify("/live", {"origin": "tui"})),
        "notif-any": lambda self: self.run_action_bg("notifications.any", lambda: self.control.notify("/live", {"any": True, "origin": "tui"})),
        "notif-clear": lambda self: self.run_action_bg("notifications.clear", lambda: self.control.notify("/live", method="DELETE")),
        "notif-storm": lambda self: self.run_action_bg(
            "notifications.storm", lambda: self.control.notify("/live/storm", {"mode": "random", "count": 5, "interval": 400})
        ),
        # dialogs
        "dialog-show": lambda self: self._dialog_show(),
        "dialog-storm": lambda self: self._dialog_storm(),
        "dialog-clear": lambda self: self.run_action_bg("dialogs.clear", lambda: self.control.dialog("/live", method="DELETE")),
        # hand fx
        "handfx-prev": lambda self: self.run_action_bg("handfx.effect.prev", lambda: self.control.handfx("effect.prev")),
        "handfx-next": lambda self: self.run_action_bg("handfx.effect.next", lambda: self.control.handfx("effect.next")),
        "handfx-apply": lambda self: self._handfx_apply(),
        "handfx-fire": lambda self: self.run_action_bg("handfx.fire", lambda: self.control.handfx_fire(self._handfx_skin)),
        "handfx-skin": lambda self: self._handfx_skin_cycle(),
        "handfx-tracking": lambda self: self.run_action_bg("handfx.tracking.toggle", lambda: self.control.handfx("tracking.toggle")),
        "handfx-mirror": lambda self: self.run_action_bg("handfx.mirror.toggle", lambda: self.control.handfx("mirror.toggle")),
        "handfx-clear": lambda self: self.run_action_bg("handfx.edit.clear", lambda: self.control.handfx("edit.clear")),
        "handfx-reload": lambda self: self.run_action_bg("handfx.reload", lambda: self.control.handfx("reload")),
        # settings / log
        "settings-restart": lambda self: self._btn_restart(),
        "log-pause": lambda self: self._toggle_follow(),
    }

    # ---- wall -----------------------------------------------------------------------
    def _wall_run(self) -> None:
        try:
            picked = self.query_one("#wall-cmds", SelectionList).selected
        except Exception:  # noqa: BLE001
            picked = []
        if not picked:
            self.set_footer("wall: pick a command first", "yellow")
            return
        cmd = str(picked[0])
        self.run_action_bg(f"wall.{cmd}", lambda: self.control.wall_cmd(cmd))

    def on_data_table_row_selected(self, event: DataTable.RowSelected) -> None:
        table_id = event.data_table.id
        key = str(event.row_key.value) if event.row_key is not None and event.row_key.value is not None else ""
        if not key:
            return
        if table_id == "wall-table":
            self._select_wall_row(key)
        elif table_id == "settings-server":
            self._select_server_row(key)
        elif table_id == "settings-config":
            self._select_config_row(key)

    def _select_wall_row(self, key: str) -> None:
        meta = self._wall_owner_map.get(key) or {}
        kind = str(meta.get("type") or "string").lower()
        value = meta.get("value", "")
        label = str(meta.get("label") or key)
        hint = self.query_one("#wall-edit-hint", Static)
        if kind in ("bool", "boolean"):
            new_value = not is_true(value)
            hint.update(f"{label}: {'true' if new_value else 'false'} (clicking the row toggles)")
            self.run_action_bg(
                f"wall.{key}",
                lambda: self.control.wall_patch({key: new_value}),
            )
            return
        self._selected_setting = ("wall", key)
        hint.update(f"{label} ({kind}) — edit below and press Enter")
        self.query_one("#wall-edit-label", Label).update(f"{label}:")
        selector = self.query_one("#wall-edit-select", Select)
        values = meta.get("values") or []
        if kind in ("enum", "select", "choice") and values:
            selector.set_options([(str(v), str(v)) for v in values])
            if value in values:
                selector.value = value
            selector.display = True
            self.query_one("#wall-edit-input", Input).display = False
        else:
            selector.display = False
            field = self.query_one("#wall-edit-input", Input)
            field.display = True
            field.value = "" if value is None else str(value)
            field.focus()

    def _submit_wall_value(self, raw: str) -> None:
        if not self._selected_setting or self._selected_setting[0] != "wall":
            self.set_footer("wall: select a setting row first", "yellow")
            return
        key = self._selected_setting[1]
        meta = self._wall_owner_map.get(key) or {}
        value, error = coerce(str(meta.get("type") or "string"), raw, meta)
        if error:
            self.query_one("#wall-edit-hint", Static).update(f"[red]{error}[/red]")
            self.set_footer(f"wall.{key}: rejected — {error}", "red")
            return
        self.run_action_bg(f"wall.{key}", lambda: self.control.wall_patch({key: value}))

    # ---- settings -------------------------------------------------------------------
    def _select_server_row(self, row_key: str) -> None:
        owner = self._settings_owner_map.get(row_key)
        if not owner:
            return
        settings_key = row_key.split(":", 1)[1]
        rows = self._settings_doc.get(owner) or {}
        meta = rows.get(settings_key) or {}
        kind = str(meta.get("type") or "string").lower()
        label = str(meta.get("label") or settings_key)
        if kind in ("bool", "boolean"):
            new_value = not is_true(meta.get("value"))
            self.run_action_bg(
                f"{owner}.{settings_key}",
                lambda: self.control.patch({settings_key: new_value}, module=None if owner == "core" else owner),
            )
            return
        self._selected_setting = (owner, settings_key)
        hint = self.query_one("#settings-hint", Static)
        hint.update(f"{owner} · {label} ({kind}) — edit below and press Enter")
        self.query_one("#settings-edit-label", Label).update(f"{label}:")
        selector = self.query_one("#settings-edit-select", Select)
        values = meta.get("values") or []
        if kind in ("enum", "select", "choice") and values:
            selector.set_options([(str(v), str(v)) for v in values])
            if meta.get("value") in values:
                selector.value = meta.get("value")
            selector.display = True
            self.query_one("#settings-edit-input", Input).display = False
        else:
            selector.display = False
            field = self.query_one("#settings-edit-input", Input)
            field.display = True
            field.value = "" if meta.get("value") is None else str(meta.get("value"))
            field.focus()

    def _submit_server_value(self, raw: str) -> None:
        if not self._selected_setting or self._selected_setting[0] == "wall":
            self.set_footer("settings: select a row first", "yellow")
            return
        owner, key = self._selected_setting
        rows = self._settings_doc.get(owner) or {}
        meta = rows.get(key) or {}
        value, error = coerce(str(meta.get("type") or "string"), raw, meta)
        if error:
            self.query_one("#settings-hint", Static).update(f"[red]{error}[/red]")
            self.set_footer(f"{owner}.{key}: rejected — {error}", "red")
            return
        self.run_action_bg(
            f"{owner}.{key}",
            lambda: self.control.patch({key: value}, module=None if owner == "core" else owner),
        )

    def _select_config_row(self, key: str) -> None:
        current = self._config_map.get(key, "")
        self._settings_owner_map[key] = "config"
        self._selected_setting = ("config", key)
        hint = self.query_one("#settings-hint", Static)
        hint.update(f"config.json · {key} — needs a restart to apply")
        self.query_one("#settings-edit-label", Label).update(f"{key}:")
        self.query_one("#settings-edit-select", Select).display = False
        field = self.query_one("#settings-edit-input", Input)
        field.display = True
        field.value = "" if key == "obs.password" else str(current)
        field.focus()

    def _submit_config_value(self, raw: str) -> None:
        if not self._selected_setting or self._selected_setting[0] != "config":
            self.set_footer("settings: select a config row first", "yellow")
            return
        key = self._selected_setting[1]
        if key == "obs.password":
            value: Any = raw
        elif key == "obs.enabled":
            coerced, error = coerce("bool", raw, {})
            if error:
                self.set_footer(f"config.{key}: rejected — {error}", "red")
                return
            value = coerced
        elif key in ("port", "compatPort"):
            coerced, error = coerce("int", raw, {"min": 0, "max": 65535})
            if error:
                self.set_footer(f"config.{key}: rejected — {error}", "red")
                return
            value = coerced
        else:
            value = raw
        self.run_action_bg(f"config.{key}", lambda: self._patch_config({key: value}))

    def _patch_config(self, changes: dict) -> dict:
        try:
            return self.control.patch(changes)
        except ConfigError as err:
            return {"ok": False, "error": str(err)}

    # ---- dialogs --------------------------------------------------------------------
    def _dialog_count(self) -> int:
        raw = self.query_one("#dialog-count", Input).value
        try:
            return max(1, min(12, int(raw or "1")))
        except ValueError:
            return 1

    def _dialog_show(self) -> None:
        count = self._dialog_count()

        def call() -> dict:
            """Spawn one at a time, stopping at the first refusal. The footer reports what the
            server returned, never a locally incremented counter."""
            replies: list[dict] = []
            for _ in range(count):
                reply = self.control.dialog("/live", {"origin": "tui"})
                if not isinstance(reply, dict):
                    return {"ok": True, "note": f"server replied {reply!r}"}
                if reply.get("ok") is False or reply.get("error"):
                    return {"ok": False, "error": str(reply.get("error") or "server said not ok")}
                replies.append(reply)
            first = replies[0] if replies else {}
            for key in ("spawned", "count", "entity", "id"):
                if key in first:
                    value = first[key]
                    if key == "entity" and isinstance(value, dict):
                        value = value.get("id", value)
                    return {"ok": True, "note": f"{key} {value}"}
            if first:
                return {"ok": True, "note": "reply: " + ", ".join(sorted(first))}
            return {"ok": True, "note": "no reply"}

        self.run_action_bg("dialogs.show", call)

    def _dialog_storm(self) -> None:
        count = self._dialog_count()
        body = {"mode": "random", "count": count, "interval": 400}
        self.run_action_bg("dialogs.storm", lambda: self.control.dialog("/live/storm", body))

    # ---- hand fx --------------------------------------------------------------------
    def _handfx_apply(self) -> None:
        try:
            picked = list(self.query_one("#handfx-list", SelectionList).selected)
        except Exception:  # noqa: BLE001
            picked = []
        ids = [str(v) for v in picked]
        if not ids:
            # An empty `effect.set` would clear every effect: refuse instead of being destructive.
            self.set_footer("handfx.effect.set: pick an effect first", "yellow")
            return
        self.run_action_bg("handfx.effect.set", lambda: self.control.handfx("effect.set", {"value": ids}))

    def _handfx_skin_cycle(self) -> None:
        """Advance the skin locally, then confirm it against a live status read.

        The local cycle only picks a *candidate*; the footer reports the server's own skin list
        and never claims a switch the server did not confirm.
        """
        candidates = self._handfx_skins or ["projectile", "heart"]
        try:
            index = (candidates.index(self._handfx_skin) + 1) % len(candidates)
        except ValueError:
            index = 0
        candidate = candidates[index]
        self._handfx_skin = candidate

        def call() -> dict:
            status = self.control.handfx_status()
            skins = self._skins_from(status or {})
            if skins and candidate not in skins:
                return {"ok": False, "error": f"server does not offer skin {candidate!r} (has: {', '.join(skins)})"}
            known = ", ".join(skins) if skins else "unknown"
            return {"ok": True, "note": f"skin set locally: {candidate} (server skins: {known})"}

        self.run_action_bg("handfx.skin", call)

    # ---- log ------------------------------------------------------------------------
    def _toggle_follow(self) -> None:
        self._follow_log = not self._follow_log
        button = self.query_one("#log-pause", Button)
        button.label = "Pause" if self._follow_log else "Follow"
        self.set_footer(f"log: {'following' if self._follow_log else 'paused'}", "green")

    def on_input_submitted(self, event: Input.Submitted) -> None:
        input_id = event.input.id
        if input_id == "wall-edit-input":
            self._submit_wall_value(event.value)
        elif input_id == "settings-edit-input":
            if self._selected_setting and self._selected_setting[0] == "config":
                self._submit_config_value(event.value)
            else:
                self._submit_server_value(event.value)
        elif input_id == "log-filter":
            self._log_filter = event.value.strip()
            self.set_footer(f"log filter: {self._log_filter or '(none)'}", "green")

    def on_select_changed(self, event: Select.Changed) -> None:
        select_id = event.select.id
        value = event.value
        if value is None or value is Select.BLANK:
            return
        if select_id == "wall-edit-select" and self._selected_setting and self._selected_setting[0] == "wall":
            key = self._selected_setting[1]
            self.run_action_bg(f"wall.{key}", lambda: self.control.wall_patch({key: value}))
        elif select_id == "settings-edit-select" and self._selected_setting and self._selected_setting[0] not in ("wall", "config"):
            owner, key = self._selected_setting
            self.run_action_bg(
                f"{owner}.{key}",
                lambda: self.control.patch({key: value}, module=None if owner == "core" else owner),
            )

    # ---- bindings -------------------------------------------------------------------
    def action_poll_now(self) -> None:
        self._poll_now()

    def action_start(self) -> None:
        self._btn_start()

    def action_stop(self) -> None:
        self._btn_stop()

    def action_restart(self) -> None:
        self._btn_restart()

    def action_clear_log(self) -> None:
        self.query_one("#log-view", RichLog).clear()
        self._log_lines.clear()
        self.set_footer("log: view cleared", "green")


# ---- entry point ------------------------------------------------------------------------


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m shockbox_tui",
        description="ShockBox controller: supervises server.mjs, edits settings, reads /health.",
    )
    parser.add_argument("--app-dir", default=None, help="the ShockBox checkout holding server.mjs (default: this repo)")
    parser.add_argument("--port", type=int, default=None, help=f"the server's port (default: config.json, else {DEFAULT_PORT})")
    parser.add_argument("--runtime-dir", default=None, help="where status.json/cmd.json/lock live (default: machine-wide ProgramData\\ShockBox\\runtime on Windows, ~/.local/state/shockbox elsewhere)")
    parser.add_argument("--poll", type=float, default=1.5, help="refresh period in seconds (default: 1.5)")
    parser.add_argument("--no-start", action="store_true", help="open the window without starting the server")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_arg_parser().parse_args(argv)
    paths = Paths.resolve(args.app_dir, args.runtime_dir)
    if not paths.server_script.exists():
        print(
            f"shockbox_tui: no server.mjs in {paths.app_dir}\n"
            "  pass --app-dir pointing at the ShockBox install (the folder holding server.mjs).",
            file=sys.stderr,
        )
        return 2

    try:
        control = Control(app_dir=paths.app_dir, port=args.port, runtime_dir=paths.runtime_dir)
    except Exception as err:  # noqa: BLE001 - a bad config.json should say so, not traceback
        print(f"shockbox_tui: cannot construct the controller: {err}", file=sys.stderr)
        return 2

    if not args.no_start:
        try:
            control.start()
        except Exception as err:  # noqa: BLE001 - the window opens regardless
            print(f"shockbox_tui: start failed: {err}", file=sys.stderr)

    ShockBoxApp(control, poll=args.poll).run()
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
