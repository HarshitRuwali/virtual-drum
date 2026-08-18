"""Zone model, lookup order, calibration (PLAN 6.1)."""
import json

import pytest

from vdrum.zones import Zone, ZoneSet, default_zones


def test_contains_is_inclusive_on_edges():
    z = Zone(id="z", x0=0.5, x1=0.9, y0=0.4, y1=0.8, scale_min=0.0, scale_max=1.0)
    assert z.contains(0.5, 0.4, 0.3)
    assert z.contains(0.9, 0.8, 0.3)
    assert z.contains(0.7, 0.6, 0.3)
    assert not z.contains(0.49, 0.4, 0.3)
    assert not z.contains(0.91, 0.6, 0.3)
    assert not z.contains(0.7, 0.81, 0.3)


def test_scale_band_rejects_out_of_depth():
    z = Zone(id="z", x0=0.0, x1=1.0, y0=0.0, y1=1.0, scale_min=0.2, scale_max=0.6)
    assert z.contains(0.5, 0.5, 0.2)
    assert z.contains(0.5, 0.5, 0.5)
    assert not z.contains(0.5, 0.5, 0.1)
    assert not z.contains(0.5, 0.5, 0.7)


def test_first_match_in_list_order_wins():
    full = lambda id_: Zone(id=id_, x0=0.0, x1=1.0, y0=0.0, y1=1.0)
    zs = ZoneSet(zones=[full("a"), full("b")])
    assert zs.lookup(0.5, 0.5, 0.5).id == "a"


def test_lookup_returns_none_when_outside():
    zs = ZoneSet(zones=[Zone(id="a", x0=0.9, x1=1.0, y0=0.9, y1=1.0)])
    assert zs.lookup(0.1, 0.1, 0.5) is None


def test_default_zones_map_the_kit():
    zs = default_zones()
    assert zs.lookup(0.89, 0.60, 0.10).id == "snare"
    assert zs.lookup(0.30, 0.60, 0.10).id == "hi-hat"
    assert zs.lookup(0.89, 0.92, 0.10).id == "kick"
    assert zs.lookup(1.42, 0.30, 0.10).id == "ride"
    assert zs.lookup(0.05, 0.05, 0.10) is None  # top-left corner: no zone


def test_calibrate_uses_median_and_padding():
    zs = ZoneSet(zones=[])
    samples = [(0.5, 0.5, 0.1)] * 7 + [(0.9, 0.9, 0.1)]  # one outlier frame
    z = zs.calibrate("snare", samples, padding=0.08)
    assert (z.x0, z.x1) == (0.42, 0.58)
    assert (z.y0, z.y1) == (0.42, 0.58)
    assert z.contains(0.5, 0.5, 0.1)
    assert not z.contains(0.9, 0.9, 0.1)  # the outlier is NOT absorbed


def test_calibrate_rejects_empty():
    with pytest.raises(ValueError):
        ZoneSet(zones=[]).calibrate("snare", [])


def test_dict_roundtrip(tmp_path):
    zs = default_zones()
    p = tmp_path / "zones.json"
    p.write_text(json.dumps(zs.to_dict()))
    zs2 = ZoneSet.load(p)
    assert [(z.id, z.x0, z.x1, z.y0, z.y1) for z in zs2.zones] == [
        (z.id, z.x0, z.x1, z.y0, z.y1) for z in zs.zones
    ]
