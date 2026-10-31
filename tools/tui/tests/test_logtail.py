"""Log tail, follow, and the rollover rules shared with core/log.mjs."""

from __future__ import annotations

from pathlib import Path

import pytest

from shockbox_tui.control import Control
from shockbox_tui.logtail import KEEP, LogFile, tail
from shockbox_tui.paths import Paths


def _lines(path: Path) -> list[str]:
    return path.read_text(encoding="utf-8").splitlines()


# ---- tail -----------------------------------------------------------------------------------


def test_tail_returns_last_n(tmp_path: Path):
    log = tmp_path / "shockbox-2026-01-02.log"
    log.write_text("\n".join(f"line {i}" for i in range(1, 51)) + "\n", encoding="utf-8")
    assert tail(log, 3)[0] == ["line 48", "line 49", "line 50"]
    assert len(tail(log, 200)[0]) == 50
    assert tail(tmp_path / "absent.log", 5) == ([], 0)


def test_tail_includes_unwritten_trailing_line(tmp_path: Path):
    log = tmp_path / "x.log"
    log.write_text("a\nb\npartial", encoding="utf-8")
    assert tail(log, 10)[0] == ["a", "b", "partial"]


def test_tail_follow_returns_only_new_lines(tmp_path: Path):
    log = tmp_path / "today.log"
    log.write_text("one\ntwo\n", encoding="utf-8")
    lines, offset = tail(log, 100)
    assert lines == ["one", "two"]

    with open(log, "a", encoding="utf-8") as fh:
        fh.write("three\n")
    lines, offset2 = tail(log, 100, since_offset=offset)
    assert lines == ["three"]
    assert offset2 > offset

    # Nothing appended: nothing returned, offset unchanged.
    assert tail(log, 100, since_offset=offset2) == ([], offset2)


def test_control_tail_log_and_follow(tmp_path: Path):
    app = tmp_path / "app"
    app.mkdir()
    ctl = Control(app_dir=app, port=1, runtime_dir=tmp_path / "rt")
    log = ctl.paths.log_file()
    log.parent.mkdir(parents=True, exist_ok=True)
    log.write_text("\n".join(f"e{i}" for i in range(1, 11)) + "\n", encoding="utf-8")

    assert ctl.tail_log(3) == ["e8", "e9", "e10"]
    # First follow behaves like a tail (nothing consumed yet)…
    assert ctl.tail_log(100, follow=True) == [f"e{i}" for i in range(1, 11)]
    # …and then only what was appended in between.
    with open(log, "a", encoding="utf-8") as fh:
        fh.write("e11\ne12\n")
    assert ctl.tail_log(100, follow=True) == ["e11", "e12"]
    assert ctl.tail_log(100, follow=True) == []


# ---- rollover ---------------------------------------------------------------------------------


def _family(log: Path) -> list[str]:
    return sorted(p.name for p in log.parent.iterdir() if p.name.startswith(log.name))


def test_rollover_on_write_boundary(tmp_path: Path):
    log = tmp_path / "shockbox-2026-01-02.log"
    writer = LogFile(tmp_path, name=log.name, max_bytes=20, keep=KEEP)
    writer.write("12345678")  # 9 bytes with newline
    writer.write("12345678")  # 18 total: still under
    assert writer.size == 18
    writer.write("12345678")  # 27 > 20 → rotate first, new file holds only this line
    assert log.read_text(encoding="utf-8") == "12345678\n"
    assert (tmp_path / f"{log.name}.1").read_text(encoding="utf-8") == "12345678\n12345678\n"


def test_rollover_caps_family_at_four_files(tmp_path: Path):
    log = tmp_path / "shockbox-2026-01-02.log"
    writer = LogFile(tmp_path, name=log.name, max_bytes=8, keep=KEEP)
    for i in range(10):
        writer.write(f"line{i:02d}")  # 7 bytes each: every write rotates
    names = _family(log)
    assert names == [
        log.name,
        f"{log.name}.1",
        f"{log.name}.2",
        f"{log.name}.3",
    ], names
    # Newest first through the generations.
    assert log.read_text(encoding="utf-8").strip() == "line09"
    assert (tmp_path / f"{log.name}.1").read_text(encoding="utf-8").strip() == "line08"
    assert (tmp_path / f"{log.name}.2").read_text(encoding="utf-8").strip() == "line07"
    assert (tmp_path / f"{log.name}.3").read_text(encoding="utf-8").strip() == "line06"


def test_rotation_on_open_when_file_already_over_budget(tmp_path: Path):
    log = tmp_path / "shockbox-2026-01-02.log"
    log.write_text("x" * 100, encoding="utf-8")
    writer = LogFile(tmp_path, name=log.name, max_bytes=10, keep=KEEP)
    assert writer.size < 100
    assert (tmp_path / f"{log.name}.1").exists()


def test_default_name_is_local_date(tmp_path: Path):
    from shockbox_tui.paths import local_day

    writer = LogFile(tmp_path / "logs")
    assert writer.path is not None
    assert writer.path.name == f"shockbox-{local_day()}.log"
    writer.write("hello")
    assert "hello" in writer.path.read_text(encoding="utf-8")


def test_paths_log_file_uses_local_date(tmp_path: Path):
    from shockbox_tui.paths import local_day

    paths = Paths.resolve(tmp_path, tmp_path / "rt")
    assert paths.log_file().name == f"shockbox-{local_day()}.log"
