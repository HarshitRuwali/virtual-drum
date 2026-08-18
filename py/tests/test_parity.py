"""Parity fixtures (PLAN 7.2): the exact JSON surface the TS gate consumes.

The TS test (web/test/parity.test.ts) reads web/test/fixtures/*.json, runs the
TS detect() on `track` with `config`, and must reproduce `expected` exactly.
These tests pin that the fixtures are well-formed and that the Python side is
stable under the JSON round-trip (floats survive `json` exactly via repr).
"""
import json
from pathlib import Path

from vdrum.config import Config, default_config
from vdrum.detect import Track, detect
from vdrum.testgen import CASES, gen_cases, write_fixtures
from vdrum.zones import default_zones


def test_write_fixtures_roundtrip(tmp_path):
    cfg = default_config()
    zones = default_zones()
    paths = write_fixtures(tmp_path, cfg, zones)
    assert len(paths) == len(CASES)
    for path, case in zip(paths, CASES):
        raw = json.loads(path.read_text())
        assert raw["name"] == case.name

        track = Track.from_json(raw["track"])
        cfg_i = Config.from_dict(raw["config"])
        hits = detect(track, cfg_i, zones)

        assert len(hits) == raw["expected"]["count"], case.name
        for h, e in zip(hits, raw["expected"]["hits"]):
            assert h.report_t_ms == e["t_ms"]
            assert h.peak_t_ms == e["peak_t_ms"]
            assert h.hand == e["hand"]
            assert h.zone == e["zone"]
            assert h.velocity == e["velocity"]


def test_fixture_schema_is_ts_consumable():
    """Field-for-field schema check for the TS parity test."""
    cases = gen_cases(default_config(), default_zones())
    c = cases[0]

    assert set(c) == {"name", "description", "config", "track", "expected"}
    assert set(c["config"]) == {"filter", "detection", "hand"}
    assert set(c["config"]["filter"]) == {"min_cutoff", "beta", "d_cutoff"}
    assert set(c["config"]["detection"]) == {
        "v_min", "v_max", "decel_ratio", "refrac_ms", "offset_ms", "min_conf", "match_window_ms",
    }
    assert set(c["config"]["hand"]) == {"track_landmark", "palm_a", "palm_b", "num_hands"}

    tr = c["track"]
    assert tr["hands"] == ["R"]
    for key in ("t_ms", "R"):
        assert key in tr
    for key in ("x", "y", "scale", "conf", "present"):
        assert key in tr["R"]
    n = len(tr["t_ms"])
    assert n > 0
    for key in ("x", "y", "scale", "conf", "present"):
        assert len(tr["R"][key]) == n

    assert set(c["expected"]) == {"count", "hits"}
    if c["expected"]["hits"]:
        assert set(c["expected"]["hits"][0]) == {"t_ms", "peak_t_ms", "hand", "zone", "velocity"}


def test_expected_hits_are_sorted_by_report_time():
    for c in gen_cases(default_config(), default_zones()):
        ts = [h["t_ms"] for h in c["expected"]["hits"]]
        assert ts == sorted(ts), c["name"]
