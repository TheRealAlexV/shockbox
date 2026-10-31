"""Local config.json editing: masking, atomic writes, validation, no secret leaks."""

from __future__ import annotations

import json
import os
import stat
from pathlib import Path

import pytest

from shockbox_tui.settings import (
    SECRET_MASK,
    ConfigError,
    masked_secret,
    port_of,
    read_config,
    sound_dir,
    write_config_patch,
)


@pytest.fixture
def cfg(tmp_path: Path) -> Path:
    path = tmp_path / "config.json"
    path.write_text(
        json.dumps(
            {
                "port": 8972,
                "host": "127.0.0.1",
                "soundsDir": "C:\\OBS\\Sounds\\SoundBoard",
                "obs": {"url": "ws://127.0.0.1:4455", "password": "hunter2", "enabled": True},
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    return path


def test_password_is_masked_by_default(cfg: Path):
    data = read_config(cfg)
    assert data["obs"]["password"] == SECRET_MASK
    assert data["obs"]["passwordSet"] is True
    # The whole rendered document must not contain the real secret anywhere.
    assert "hunter2" not in json.dumps(data)


def test_reveal_is_explicit(cfg: Path):
    assert read_config(cfg, reveal=True)["obs"]["password"] == "hunter2"


def test_masked_password_round_trip_keeps_secret(cfg: Path):
    before = cfg.read_text()
    write_config_patch(cfg, {"obs.password": SECRET_MASK, "soundsDir": "D:\\Sounds"})
    after = json.loads(cfg.read_text())
    assert after["obs"]["password"] == "hunter2"
    assert after["soundsDir"] == "D:\\Sounds"
    assert "hunter2" in cfg.read_text()
    assert before != cfg.read_text()


def test_write_sounds_dir_leaves_other_keys_alone(cfg: Path):
    write_config_patch(cfg, {"soundsDir": "D:\\Audio"})
    data = json.loads(cfg.read_text())
    assert data["soundsDir"] == "D:\\Audio"
    assert data["port"] == 8972
    assert data["obs"]["enabled"] is True
    assert sound_dir(cfg) == "D:\\Audio"


def test_write_is_atomic_and_keeps_permissions(cfg: Path):
    os.chmod(cfg, stat.S_IRUSR | stat.S_IWUSR)  # 0600: it holds a secret
    write_config_patch(cfg, {"port": 9000})
    assert stat.S_IMODE(cfg.stat().st_mode) == 0o600
    # No temp files left behind next to it.
    assert [p.name for p in cfg.parent.iterdir() if p.name != "config.json"] == []


def test_missing_file_is_created(tmp_path: Path):
    path = tmp_path / "nope.json"
    assert read_config(path)["obs"]["passwordSet"] is False
    assert port_of(path) == 8972
    write_config_patch(path, {"port": "9001"})
    assert port_of(path) == 9001


@pytest.mark.parametrize(
    "changes,message",
    [
        ({"port": 70000}, "between 0 and 65535"),
        ({"port": "eighty"}, "whole number"),
        ({"obs.url": "http://x"}, "ws://"),
        ({"obs.enabled": "yes"}, "true or false"),
        ({"bogusKey": 1}, "unknown setting"),
        ({"soundsDir": "  "}, "non-empty"),
    ],
)
def test_invalid_values_rejected_and_file_untouched(cfg: Path, changes: dict, message: str):
    before = cfg.read_text()
    with pytest.raises(ConfigError) as err:
        write_config_patch(cfg, changes)
    assert message in str(err.value)
    assert cfg.read_text() == before


def test_masked_secret_helper():
    assert masked_secret("x") == SECRET_MASK
    assert masked_secret("") == ""
