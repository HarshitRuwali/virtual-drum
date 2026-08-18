/** Hit detection on cached landmark tracks. THE PORTED CORE (PLAN 5, 9b).
 *
 * TS port of `py/vdrum/detect.py`: same operations, same order, same numbers
 * -- that is what the parity gate (PLAN 7.2) checks. Do not "improve" one
 * side independently.
 *
 * Timing rules (PLAN 3.1, 3.2, 5):
 *   * t_ms is always the FRAME capture clock, never wall time.
 *   * Audio fires at peak detection (buys back 20-40 ms of pipeline latency).
 *   * The REPORTED timestamp is peak_t + OFFSET_MS, i.e. offset to the true
 *     strike instant so the readout stays honest (PLAN 8).
 */

import type { Config } from "./config";
import { OneEuro } from "./filter";
import type { Zone, ZoneSet } from "./zones";

/** A position gap larger than this between two present frames is a hand
 * re-identification glitch, not a strike; never let it feed the velocity
 * state machine (a teleport across the frame would otherwise read as a strike).
 */
export const GAP_MS = 150.0;

export interface Hit {
  report_t_ms: number;
  peak_t_ms: number;
  hand: string; // "L" | "R" (or a marker id later)
  zone: string | null;
  velocity: number;
}

export interface Channel {
  x: number[];
  y: number[];
  scale: number[];
  conf: number[];
  present: number[];
}

export interface Track {
  t_ms: number[];
  channels: Record<string, Channel>;
}

export class HandState {
  /** Per-hand velocity state machine (PLAN 5), with the One Euro filter.
   *
   * IDLE -> DESCENDING on vy_n > V_MIN; track the running peak; FIRE once
   * velocity decays to DECEL_RATIO of the peak; REFRACTORY blocks a re-strike
   * until REFRAC_MS has elapsed AND the velocity has settled back below V_MIN;
   * V_MIN is the ONLY gate on what counts as a strike. A "faded out below
   * V_MIN/2 -> cancel" branch used to sit here but was unreachable for any
   * DECEL_RATIO >= 0.5 (it needs peak < V_MIN*0.5/DECEL_RATIO = 0.667 while
   * DESCENDING requires peak > V_MIN = 0.8). Mirrors py/vdrum/detect.py.
   *
   * The settle test is load-bearing: the One Euro filter keeps "descending"
   * for hundreds of ms after the hand actually stops (its tail catching up),
   * and a time-only refractory would let that tail re-arm and fire a ghost
   * second hit ~180 ms later. A genuine re-strike always rebounds first (the
   * hand goes back up), which settles the velocity and passes both tests.
   *
   * A stroke still in progress when tracking is lost (the hand exits the
   * frame, or confidence drops) is committed by commitIfPending() at its
   * observed peak: otherwise the decel confirmation never arrives and a hand
   * that leaves the frame right after a strike loses the hit entirely.
   */

  hand: string;
  oe: OneEuro;
  state: "IDLE" | "DESCENDING" | "REFRACTORY";
  peak = 0.0;
  peak_t = 0.0;
  fire_t = 0.0;
  peak_x = 0.0;
  peak_y = 0.0;
  peak_scale = 1.0;
  yf_prev: number | null = null;
  t_prev: number | null = null;

  constructor(hand: string, cfg: Config) {
    const f = cfg.filter;
    this.hand = hand;
    this.oe = new OneEuro(f.min_cutoff, f.beta, f.d_cutoff);
    this.state = "IDLE";
  }

  step(
    t_ms: number,
    x: number,
    y: number,
    scale: number,
    cfg: Config,
    zones: ZoneSet | null,
  ): Hit | null {
    const det = cfg.detection;
    if (this.t_prev !== null && t_ms - this.t_prev > GAP_MS) {
      // The hand left and came back (or a re-ID glitch). The One Euro
      // filter's memory across the gap would read as a phantom stroke, so
      // resync the filter too. Any in-progress stroke was already committed
      // by commitIfPending() before we got here.
      this.oe.reset();
      this.state = "IDLE";
      this.yf_prev = null;
      this.t_prev = null;
    }
    const yf = this.oe.step(t_ms / 1000.0, y);
    if (this.yf_prev === null) {
      this.yf_prev = yf;
      this.t_prev = t_ms;
      return null;
    }
    const gap = t_ms - (this.t_prev as number);
    if (gap <= 0.0) {
      this.yf_prev = yf;
      this.t_prev = t_ms;
      return null;
    }
    const vy_n = (yf - (this.yf_prev as number)) / (gap / 1000.0) / scale;
    this.yf_prev = yf;
    this.t_prev = t_ms;

    if (this.state === "IDLE") {
      if (vy_n > det.v_min) {
        this.state = "DESCENDING";
        this.peak = vy_n;
        this.peak_t = t_ms;
        this.peak_x = x;
        this.peak_y = yf;
        this.peak_scale = scale;
      }
    } else if (this.state === "DESCENDING") {
      if (vy_n > this.peak) {
        this.peak = vy_n;
        this.peak_t = t_ms;
        this.peak_x = x;
        this.peak_y = yf;
        this.peak_scale = scale;
      } else if (vy_n < this.peak * det.decel_ratio) {
        const hit = this.fire(cfg, zones);
        this.state = "REFRACTORY";
        this.fire_t = t_ms;
        return hit;
      }
    } else if (this.state === "REFRACTORY") {
      if (t_ms - this.fire_t > det.refrac_ms && vy_n < det.v_min) {
        this.state = "IDLE";
      }
    }
    return null;
  }

  private fire(cfg: Config, zones: ZoneSet | null): Hit {
    const det = cfg.detection;
    const span = det.v_max - det.v_min;
    const velocity =
      span > 0 ? Math.max(0.0, Math.min(1.0, (this.peak - det.v_min) / span)) : 0.0;
    const zone: Zone | null = zones
      ? zones.lookup(this.peak_x, this.peak_y, this.peak_scale)
      : null;
    return {
      report_t_ms: this.peak_t + det.offset_ms,
      peak_t_ms: this.peak_t,
      hand: this.hand,
      zone: zone ? zone.id : null,
      velocity: velocity,
    };
  }

  /** The hand stopped being tracked (left the frame, low confidence, zero
   * scale) while a stroke was in progress: commit it at its observed peak.
   * Without this, the decel confirmation never arrives for a hand that
   * leaves the frame right after a strike, and the hit is lost.
   */
  commitIfPending(cfg: Config, zones: ZoneSet | null, t_ms: number): Hit | null {
    if (this.state !== "DESCENDING") return null;
    const hit = this.fire(cfg, zones);
    this.state = "REFRACTORY";
    this.fire_t = t_ms;
    return hit;
  }
}

/** Incremental version of detect(): one hand position per call.
 *
 * The live app cannot re-run the whole track every frame, but it must execute
 * EXACTLY the same per-frame code the batch `detect()` loop does -- this class
 * IS that loop body (tracked test, step vs commitIfPending, same order).
 * Parity stays valid because both paths share HandState untouched.
 */
export class StreamingDetector {
  private cfg: Config;
  private zones: ZoneSet | null;
  private states = new Map<string, HandState>();

  constructor(cfg: Config, zones: ZoneSet | null) {
    this.cfg = cfg;
    this.zones = zones;
  }

  knownHands(): string[] {
    return [...this.states.keys()];
  }

  /** A known hand is absent this frame: commit an in-progress stroke at its
   * peak (exactly the else-branch of detect() for an untracked frame). */
  commitAbsent(t_ms: number, hand: string): Hit | null {
    const hs = this.states.get(hand);
    if (hs === undefined) return null;
    return hs.commitIfPending(this.cfg, this.zones, t_ms);
  }

  step(
    t_ms: number,
    hand: string,
    present: number,
    conf: number,
    x: number,
    y: number,
    scale: number,
  ): Hit | null {
    let hs = this.states.get(hand);
    if (hs === undefined) {
      hs = new HandState(hand, this.cfg);
      this.states.set(hand, hs);
    }
    const tracked =
      present !== 0 && conf >= this.cfg.detection.min_conf && scale > 0.0;
    if (tracked) {
      return hs.step(t_ms, x, y, scale, this.cfg, this.zones);
    }
    return hs.commitIfPending(this.cfg, this.zones, t_ms);
  }
}

export function detect(track: Track, cfg: Config, zones: ZoneSet | null): Hit[] {
  const hits: Hit[] = [];
  const det = cfg.detection;
  for (const hand of Object.keys(track.channels)) {
    const ch = track.channels[hand];
    const hs = new HandState(hand, cfg);
    for (let i = 0; i < track.t_ms.length; i++) {
      const t_i = track.t_ms[i];
      const tracked =
        ch.present[i] !== 0 && ch.conf[i] >= det.min_conf && ch.scale[i] > 0.0;
      let hit: Hit | null;
      if (tracked) {
        hit = hs.step(t_i, ch.x[i], ch.y[i], ch.scale[i], cfg, zones);
      } else {
        hit = hs.commitIfPending(cfg, zones, t_i);
      }
      if (hit !== null) hits.push(hit);
    }
  }
  // Total order: simultaneous hits (same report_t_ms) must come out in the
  // same order regardless of channel key order -- required for the TS parity
  // gate (mirrors py/vdrum/detect.py).
  hits.sort(
    (a, b) =>
      a.report_t_ms - b.report_t_ms ||
      (a.hand < b.hand ? -1 : a.hand > b.hand ? 1 : 0),
  );
  return hits;
}
