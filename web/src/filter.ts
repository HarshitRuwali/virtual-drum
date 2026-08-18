/** One Euro filter (PLAN 5.1).
 *
 * TS port of `py/vdrum/filter.py`: same operations, same order, same numbers
 * (parity gate, PLAN 7.2). Do not "improve" one side independently.
 *
 * Adaptive low-pass: heavy smoothing when the hand is slow (kills jitter),
 * almost none when it is fast (no added lag exactly when the strike is
 * happening). A fixed low-pass would add lag proportional to speed and
 * destroy the very quantity being measured.
 */

export function alpha(cutoff: number, dt: number): number {
  const tau = 1.0 / (2.0 * Math.PI * cutoff);
  return 1.0 / (1.0 + tau / dt);
}

export class OneEuro {
  private min_cutoff: number;
  private beta: number;
  private d_cutoff: number;
  private t_prev: number | null = null;
  private x_prev = 0.0;
  private dx_prev = 0.0;
  private init = false;

  constructor(min_cutoff: number, beta: number, d_cutoff: number) {
    this.min_cutoff = min_cutoff;
    this.beta = beta;
    this.d_cutoff = d_cutoff;
  }

  /** Drop all memory (e.g. after a hand gap); the next sample primes. */
  reset(): void {
    this.t_prev = null;
    this.x_prev = 0.0;
    this.dx_prev = 0.0;
    this.init = false;
  }

  /** t in seconds, x the sample. Returns the filtered value. */
  step(t: number, x: number): number {
    if (!this.init) {
      this.init = true;
      this.t_prev = t;
      this.x_prev = x;
      return x;
    }
    const dt = t - (this.t_prev as number);
    if (dt <= 0.0) {
      this.t_prev = t;
      return this.x_prev;
    }
    const dx = (x - this.x_prev) / dt;
    const a_d = alpha(this.d_cutoff, dt);
    this.dx_prev = a_d * dx + (1.0 - a_d) * this.dx_prev;
    const cutoff = this.min_cutoff + this.beta * Math.abs(this.dx_prev);
    const a = alpha(cutoff, dt);
    this.x_prev = a * x + (1.0 - a) * this.x_prev;
    this.t_prev = t;
    return this.x_prev;
  }
}
