"""One Euro filter behaviour (PLAN 5.1)."""
from vdrum.filter import OneEuro, alpha


def test_alpha_formula():
    # 1 Hz at dt = 1/60 s: tau = 1/(2*pi*1) = 0.159155
    assert abs(alpha(1.0, 1 / 60) - 1.0 / (1.0 + (1.0 / (2 * 3.141592653589793)) / (1 / 60))) < 1e-12
    # high cutoff -> alpha -> 1
    assert alpha(1000.0, 1 / 60) > 0.99
    # low cutoff -> alpha -> 0
    assert alpha(0.01, 1 / 60) < 0.05


def test_first_sample_passthrough():
    f = OneEuro(1.0, 0.05, 1.0)
    assert f(0.0, 0.37) == 0.37


def test_constant_input_converges():
    f = OneEuro(1.0, 0.05, 1.0)
    out = 0.0
    for i in range(60 * 2):
        out = f(i / 60, 0.5)
    assert abs(out - 0.5) < 1e-3


def test_speed_adaptation_less_lag_when_fast():
    # A step at t=1.0 s: higher beta (speed-sensitive) must reach 90% sooner,
    # i.e. the filter adds less lag exactly when the hand is fastest.
    def settle(beta: float) -> float:
        f = OneEuro(1.0, beta, 1.0)
        t = 0.0
        out = 0.0
        reached90 = None
        i = 0
        while i < 60 * 4:
            t = i / 60
            x = 1.0 if t >= 1.0 else 0.0
            out = f(t, x)
            if out >= 0.9 and reached90 is None:
                reached90 = t
            i += 1
        return reached90

    fast = settle(0.5)
    slow = settle(0.0)
    assert fast is not None and slow is not None
    assert fast < slow


def test_monotonic_input_gives_monotonic_output():
    f = OneEuro(1.0, 0.05, 1.0)
    prev = None
    for i in range(120):
        out = f(i / 60, i / 100)
        if prev is not None:
            assert out > prev
        prev = out


def test_non_increasing_time_is_safe():
    f = OneEuro(1.0, 0.05, 1.0)
    a = f(0.0, 0.1)
    b = f(0.0, 0.9)  # dt = 0
    assert b == a  # no crash, holds last value
    c = f(1.0 / 60, 0.9)
    assert c > a
