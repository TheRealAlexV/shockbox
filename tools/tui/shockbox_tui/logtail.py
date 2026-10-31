"""Reading and writing the dated ``shockbox-YYYY-MM-DD.log`` family.

Writing mirrors ``core/log.mjs`` exactly, because two writers feed the same file — node writes
its own lines through ``createLog`` and the supervisor appends node's stdout/stderr *plus* its
own ``launcher:`` lines here. The rules are deliberately the same:

* budget is one generation (8 MiB by default), checked **before** every write;
* over budget → the live file becomes ``.1``, each older generation shifts up one, the one past
  ``keep`` (3, so four files in the family) is removed;
* rotation never raises: a locked file on Windows (a viewer has it open) stays put and the next
  write retries the whole chain;
* the day in the name is the **local** day, matching ``server.mjs``'s ``localDay()``.

Reading is used by the UI (``Control.tail_log``): read the live file only, bounded, never the
whole file into memory when the caller asked for 200 lines.
"""

from __future__ import annotations

import os
import threading
from pathlib import Path

from .paths import local_day

MAX_BYTES = 8 * 1024 * 1024
KEEP = 3

_CHUNK = 64 * 1024


def _size_of(path: Path) -> int:
    try:
        return path.stat().st_size
    except OSError:
        return 0


class LogFile:
    """Append-only writer with the ``core/log.mjs`` rotation rules. Thread-safe per instance."""

    def __init__(self, dir: os.PathLike | str, name: str | None = None, max_bytes: int = MAX_BYTES, keep: int = KEEP):
        self.dir = Path(dir)
        self.max_bytes = int(max_bytes)
        self.keep = int(keep)
        self._explicit_name = name
        self._lock = threading.Lock()
        self._day: str | None = None
        self._path: Path | None = None
        self._size = 0
        self._open(self._name_today())

    # ---- naming -----------------------------------------------------------------
    def _name_today(self) -> str:
        return self._explicit_name or f"shockbox-{local_day()}.log"

    def _open(self, name: str) -> None:
        try:
            self.dir.mkdir(parents=True, exist_ok=True)
            self._path = self.dir / name
            self._size = _size_of(self._path)
            if self._size > self.max_bytes:
                self._rotate_locked()
        except OSError:
            self._path = None
            self._size = 0

    @property
    def path(self) -> Path | None:
        return self._path

    def flush(self) -> None:
        with self._lock:
            if self._path is None:
                return
            try:
                with open(self._path, "ab") as fh:
                    fh.flush()
                    os.fsync(fh.fileno())
            except OSError:
                pass

    @property
    def size(self) -> int:
        return self._size

    def rotate(self) -> None:
        with self._lock:
            if self._path is not None:
                self._rotate_locked()

    # ---- rotation (caller holds the lock) ----------------------------------------
    def _rotate_locked(self) -> None:
        file = self._path
        if file is None:
            return
        keep = self.keep
        # Drop the oldest generation in the way, then shift the rest up. Each step separate so
        # one locked file only strands that generation; the next write retries the chain.
        if keep >= 1:
            try:
                Path(f"{file}.{keep}").unlink()
            except OSError:
                pass
        for i in range(keep - 1, 0, -1):
            try:
                Path(f"{file}.{i}").rename(Path(f"{file}.{i + 1}"))
            except OSError:
                pass
        if keep >= 1:
            try:
                _replace(file, Path(f"{file}.1"))
            except OSError:
                pass
        # Whichever rename failed, trust the disk, not the arithmetic.
        self._size = _size_of(file)

    # ---- writing -----------------------------------------------------------------
    def write(self, text: str) -> None:
        """Append ``text`` (with a newline) to today's file, rotating first when over budget.

        Never raises: a log line must not be able to take the supervisor down.
        """
        with self._lock:
            # A run that crosses local midnight continues in the new day's file, which is what
            # run.cmd does on restart and what createLog does on a fresh process.
            name = self._name_today()
            if self._explicit_name is None and self._path is not None and self._path.name != name:
                self._open(name)
            if self._path is None:
                return
            data = text if text.endswith("\n") else text + "\n"
            raw = data.encode("utf-8", "replace")
            if self._size + len(raw) > self.max_bytes:
                self._rotate_locked()
            if self._path is None:
                return
            try:
                with open(self._path, "ab", buffering=0) as fh:
                    fh.write(raw)
                self._size += len(raw)
            except OSError:
                pass


def _replace(src: Path, dst: Path) -> None:
    """``rename`` with the same overwrite semantics as an already-removed target."""
    os.replace(src, dst)


def tail(path: os.PathLike | str | None, n: int = 200, since_offset: int | None = None) -> tuple[list[str], int]:
    """Last ``n`` lines of ``path`` and the file offset they end at.

    ``since_offset`` returns only the bytes after that offset instead (what a follower needs).
    The read is bounded: at most 4 MiB is scanned for ``n`` lines, so a 200-line tail of a
    crashed-loop log costs a few milliseconds, not a 32 MiB parse.
    """
    file = Path(path) if path is not None else None
    if file is None:
        return [], 0
    try:
        size = file.stat().st_size
    except OSError:
        return [], 0

    if since_offset is not None:
        start = max(0, min(int(since_offset), size))
        try:
            with open(file, "rb") as fh:
                fh.seek(start)
                data = fh.read()
        except OSError:
            return [], start
        return _decode_lines(data), size

    n = max(0, int(n))
    if n == 0 or size == 0:
        return [], size
    floor = max(0, size - 4 * 1024 * 1024)
    start = floor
    data = b""
    try:
        with open(file, "rb") as fh:
            while True:
                fh.seek(start)
                data = fh.read(size - start)
                # Enough complete lines (a line needing a newline, or we are at BOF)?
                if data.count(b"\n") > n or start == 0:
                    break
                step = min(_CHUNK * 4, start)
                if step <= 0:
                    break
                start -= step
    except OSError:
        return [], size

    lines = _decode_lines(data)
    # A trailing partial line (no newline yet) is still the newest thing in the file: keep it.
    return lines[-n:] if n else [], size


def _decode_lines(data: bytes) -> list[str]:
    if not data:
        return []
    text = data.decode("utf-8", "replace")
    lines = text.splitlines()
    return lines
