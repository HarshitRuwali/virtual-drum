"""CLI smoke tests.

Nothing imported `vdrum.cli` before, so a stale import in it (it referenced a
config constant that had been removed) survived a fully green suite. These
tests exist mainly to make the module import-clean under CI.
"""
import json

import numpy as np
import pytest

from vdrum import cli
from vdrum.config import default_config, find_config_dir
from vdrum.detect import Channel, Track


def test_cli_module_imports_cleanly():
    assert callable(cli.main)


def test_find_config_dir_locates_shared_config():
    d = find_config_dir()
    assert (d / "default.json").is_file()
    assert (d / "zones.json").is_file()


def test_find_config_dir_honours_env(tmp_path, monkeypatch):
    (tmp_path / "default.json").write_text(json.dumps(default_config().to_dict()))
    (tmp_path / "zones.json").write_text(json.dumps({"zones": []}))
    monkeypatch.setenv("VDRUM_CONFIG_DIR", str(tmp_path))
    assert find_config_dir() == tmp_path.resolve()


def test_find_config_dir_rejects_bad_env(tmp_path, monkeypatch):
    monkeypatch.setenv("VDRUM_CONFIG_DIR", str(tmp_path / "nope"))
    with pytest.raises(FileNotFoundError):
        find_config_dir()


def test_detect_subcommand_on_a_saved_track(tmp_path, capsys):
    n = 60
    ch = Channel(
        x=np.full(n, 0.89),
        y=np.array([0.55 + 0.004 * i for i in range(n)]),
        scale=np.full(n, 0.10),
        conf=np.ones(n),
        present=np.ones(n, dtype=np.uint8),
    )
    trk = tmp_path / "clip.npz"
    Track(t_ms=np.arange(n) * 1000.0 / 60, channels={"R": ch}).save(trk)

    out = tmp_path / "hits.json"
    rc = cli.main(["detect", str(trk), "--out", str(out)])
    assert rc in (0, None)
    payload = json.loads(out.read_text())
    assert "hits" in payload and "config" in payload
