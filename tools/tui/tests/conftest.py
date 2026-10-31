"""Fixtures only. Helpers live in ``support`` so any test module can import them by name.

`pytest` loads ``conftest`` under a name it chooses; test modules that do
`from conftest import ...` can therefore bind to a second, partial copy of it depending on
plugin load order (pytest-randomly reorders exactly that). Everything importable is in
``tests/support.py``, which has one name and no plugin involvement; this file only declares
fixtures, and it imports ``support`` rather than the other way round.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

TESTS = Path(__file__).resolve().parent
# `support` and `stub_server` are importable from every test module as top-level modules.
if str(TESTS) not in sys.path:
    sys.path.insert(0, str(TESTS))

from support import free_port  # noqa: E402


@pytest.fixture
def app_dir(tmp_path: Path) -> Path:
    """A bare fake install: the directory the supervisor treats as the app dir."""
    d = tmp_path / "app"
    (d / "logs").mkdir(parents=True)
    (d / "state").mkdir(parents=True)
    return d


@pytest.fixture
def port() -> int:
    return free_port()
