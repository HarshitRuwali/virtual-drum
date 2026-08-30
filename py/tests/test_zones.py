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
    """Raw (un-mirrored) X, so the sides read reversed from the screen."""
    zs = default_zones()
    assert zs.lookup(0.89, 0.60, 0.10).id == "snare"
    assert zs.lookup(0.89, 0.92, 0.10).id == "kick"
    assert zs.lookup(1.44, 0.60, 0.10).id == "hi-hat"  # player's left
    assert zs.lookup(1.50, 0.28, 0.10).id == "crash"   # player's left, high
    assert zs.lookup(0.30, 0.60, 0.10).id == "tom"     # player's right
    assert zs.lookup(0.25, 0.28, 0.10).id == "ride"    # player's right, high
    assert zs.lookup(0.89, 0.05, 0.10) is None  # above the kit: no zone


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


# --- Kit layout: the shipped config/zones.json, not a synthetic set ---------
#
# The app draws a MIRRORED (selfie) view, so a zone's screen X is
# `ASPECT - raw_X`. These tests pin the two things that silently rot:
# (a) the mirrored layout still reads as a right-handed kit, and
# (b) testgen's hard-coded strike coordinates still land in the zones the
#     fixture names claim (they are separate files; nothing else couples them).

ASPECT = 16 / 9


def _screen_x(z):
    """Zone's horizontal span as the player SEES it (PLAN 3.5 mirroring)."""
    return (ASPECT - z.x1, ASPECT - z.x0)


def test_default_zones_are_the_expected_kit():
    ids = [z.id for z in default_zones().zones]
    assert ids == ["kick", "snare", "hi-hat", "tom", "crash", "ride"]


def test_mirrored_layout_is_a_right_handed_kit():
    zs = {z.id: z for z in default_zones().zones}
    mid = ASPECT / 2

    # Player's LEFT half of the screen.
    for zid in ("hi-hat", "crash"):
        lo, hi = _screen_x(zs[zid])
        assert hi < mid, f"{zid} should render left of centre, got {(lo, hi)}"

    # Player's RIGHT half.
    for zid in ("tom", "ride"):
        lo, hi = _screen_x(zs[zid])
        assert lo > mid, f"{zid} should render right of centre, got {(lo, hi)}"

    # Snare and kick straddle the centre; kick sits below the snare.
    for zid in ("snare", "kick"):
        lo, hi = _screen_x(zs[zid])
        assert lo < mid < hi, f"{zid} should render centred, got {(lo, hi)}"
    assert zs["kick"].y0 >= zs["snare"].y1

    # Cymbals ride above the drums they share a side with.
    assert zs["crash"].y1 <= zs["hi-hat"].y0
    assert zs["ride"].y1 <= zs["tom"].y0


def test_no_two_zones_share_area():
    """Shared EDGES are fine -- `contains` is inclusive and list order breaks
    the tie. Shared AREA is not: it makes a whole region of the later zone
    unreachable no matter how the list is ordered."""
    zones = default_zones().zones
    for i, a in enumerate(zones):
        for b in zones[i + 1:]:
            ox = min(a.x1, b.x1) - max(a.x0, b.x0)
            oy = min(a.y1, b.y1) - max(a.y0, b.y0)
            assert ox <= 0 or oy <= 0, (
                f"{a.id} and {b.id} share a {ox:.3f} x {oy:.3f} region; "
                f"{b.id} would be partly unreachable"
            )


def test_testgen_strike_coordinates_match_the_shipped_zones():
    """testgen's X constants and config/zones.json live in separate files with
    nothing but this test holding them together. If a kit re-layout moves a
    zone out from under a constant, every fixture named for that zone quietly
    starts asserting a different one."""
    from vdrum.testgen import X_HIHAT, X_SNARE

    zs = default_zones()
    by_id = {z.id: z for z in zs.zones}
    for zid, x in (("snare", X_SNARE), ("hi-hat", X_HIHAT)):
        z = by_id[zid]
        for frac in (0.05, 0.5, 0.95):
            y = z.y0 + (z.y1 - z.y0) * frac
            got = zs.lookup(x, y, 0.10)
            assert got is not None and got.id == zid, (
                f"{zid} constant x={x} at y={y:.3f} resolves to "
                f"{got.id if got else None}"
            )
