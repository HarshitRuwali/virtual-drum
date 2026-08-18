"""One Euro filter (PLAN 5.1).

Adaptive low-pass: heavy smoothing when the hand is slow (kills jitter),
almost none when it is fast (no added lag exactly when the strike is happening).
A fixed low-pass would add lag proportional to speed and destroy the very
quantity being measured.

The TS port (web/src/filter.ts) mirrors these operations one-for-one, in the
same order, so the parity gate (PLAN 7.2) sees identical numbers.
"""
from __future__ import annotations

import math


def alpha(cutoff: float, dt: float) -> float:
    """Smoothing factor for a cutoff frequency (Hz) at sample interval dt (s)."""
    tau = 1.0 / (2.0 * math.pi * cutoff)
    return 1.0 / (1.0 + tau / dt)


class OneEuro:
    __slots__ = ("min_cutoff", "beta", "d_cutoff", "t_prev", "x_prev", "dx_prev", "init")

    def __init__(self, min_cutoff: float, beta: float, d_cutoff: float):
        self.min_cutoff = min_cutoff
        self.beta = beta
        self.d_cutoff = d_cutoff
        self.t_prev: float | None = None
        self.x_prev = 0.0
        self.dx_prev = 0.0
        self.init = False

    def reset(self) -> None:
        """Drop all memory (e.g. after a hand gap); the next sample primes."""
        self.t_prev = None
        self.x_prev = 0.0
        self.dx_prev = 0.0
        self.init = False

    def __call__(self, t: float, x: float) -> float:
        """t in seconds, x the sample. Returns the filtered value."""
        if not self.init:
            self.init = True
            self.t_prev = t
            self.x_prev = x
            return x
        dt = t - self.t_prev
        if dt <= 0.0:
            self.t_prev = t
            return self.x_prev
        dx = (x - self.x_prev) / dt
        a_d = alpha(self.d_cutoff, dt)
        self.dx_prev = a_d * dx + (1.0 - a_d) * self.dx_prev
        cutoff = self.min_cutoff + self.beta * abs(self.dx_prev)
        a = alpha(cutoff, dt)
        self.x_prev = a * x + (1.0 - a) * self.x_prev
        self.t_prev = t
        return self.x_prev
