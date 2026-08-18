"""Sweep plumbing (PLAN 5.2, 7.1).

Covers the two silent failures this module shipped with: `.hits.json` stems
never matching track stems (so every sweep found zero pairs and returned an
empty table that looked like "no fixtures yet"), and a hardcoded filter-key
list that raised TypeError on any filter param other than beta.
"""
import json

import numpy as np
import pytest

from vdrum.config import default_config
from vdrum.detect import Channel, Track
from vdrum.sweep import _pairs, _split_overrides, run_sweep


def _write_track(path):
    n = 60
    y = np.array([0.5 + 0.004 * i for i in range(n)])
    ch = Channel(x=np.full(n, 0.89), y=y, scale=np.full(n, 0.1),
                 conf=np.ones(n), present=np.ones(n, dtype=np.uint8))
    Track(t_ms=np.arange(n) * 1000.0 / 60, channels={"R": ch}).save(path)


def test_pairs_matches_hits_json_to_track(tmp_path):
    fx, tr = tmp_path / "fixtures", tmp_path / "tracks"
    fx.mkdir(); tr.mkdir()
    (fx / "clip1.hits.json").write_text(json.dumps({"hits": [{"t_ms": 100.0}]}))
    _write_track(tr / "clip1.npz")
    pairs = _pairs(fx, tr)
    assert [n for n, _, _ in pairs] == ["clip1"], "stem stripping is broken"


def test_split_overrides_routes_by_dataclass_field():
    det, filt = _split_overrides({"v_min": 1.0, "beta": 0.02, "min_cutoff": 2.0})
    assert det == {"v_min": 1.0}
    assert filt == {"beta": 0.02, "min_cutoff": 2.0}


def test_split_overrides_rejects_unknown_key():
    with pytest.raises(KeyError):
        _split_overrides({"not_a_param": 1.0})


def test_sweep_accepts_a_filter_param_other_than_beta(tmp_path):
    fx, tr = tmp_path / "fixtures", tmp_path / "tracks"
    fx.mkdir(); tr.mkdir()
    (fx / "clip1.hits.json").write_text(json.dumps({"hits": [{"t_ms": 500.0}]}))
    _write_track(tr / "clip1.npz")
    rows = run_sweep(fx, default_config(), None,
                     {"min_cutoff": [0.5, 1.0]}, tracks_dir=tr)
    assert len(rows) == 2


def test_sweep_returns_empty_without_fixtures(tmp_path):
    fx, tr = tmp_path / "fixtures", tmp_path / "tracks"
    fx.mkdir(); tr.mkdir()
    assert run_sweep(fx, default_config(), None, tracks_dir=tr) == []
