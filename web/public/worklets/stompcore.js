/** Foot-stomp onset detection. Plain ES module, no imports: it has to load
 * inside an AudioWorkletGlobalScope, which has no DOM and no bundler.
 *
 * WHY AUDIO AND NOT VIDEO. A practice tool whose whole output is a millisecond
 * error cannot afford a 30-60 ms trigger. A stomp on a hard floor is a
 * broadband transient with most of its energy under ~150 Hz, and it arrives
 * over the same AudioContext the kit already plays through, so the timestamp
 * needs no cross-clock bridge to be compared against a metronome click. It is
 * the most accurate input in the app, more so than the camera-derived hands.
 *
 * The detector is a two-envelope onset test, not a plain threshold: a fixed
 * threshold is either deaf in a loud room or fires on a chair creak in a quiet
 * one. Comparing a fast envelope against a slow one measures the RISE, which
 * is what distinguishes a stomp from a room getting louder.
 */

/** @typedef {{ threshold?: number, floor?: number, cutoffHz?: number,
 *              refractoryMs?: number, fastMs?: number, slowMs?: number }} StompOpts */

export const DEFAULTS = {
  /** fast/slow envelope ratio that counts as an onset. */
  threshold: 3.2,
  /** absolute floor, so room tone alone can never satisfy the ratio. */
  floor: 0.0035,
  /** stomp energy lives below this; voice and cymbals live above it. */
  cutoffHz: 150,
  /** a foot cannot physically stomp twice inside this. */
  refractoryMs: 120,
  /** minimum share of the total energy that must be in the low band.
   *
   * Filtering alone is not enough, and measurement rather than theory says so:
   * a 3 kHz crash at 0.7 still leaks 8.9e-3 past three poles, because the
   * ONSET of any burst is broadband and gets through before the cascade
   * settles. That is 2.5x the noise floor, so every crash read as a kick.
   * Raising the floor instead would make the detector deaf to soft stomps and
   * dependent on mic gain. This compares the low band against the FULL band,
   * which is a question about spectral SHAPE and so is level-independent:
   * measured 0.70 for a stomp, 0.053 for voice, 0.013 for a crash. */
  lowFrac: 0.35,
  fastMs: 4,
  slowMs: 250,
};

export class StompDetector {
  /** @param {number} sampleRate @param {StompOpts} [opts] */
  constructor(sampleRate, opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    this.sampleRate = sampleRate;
    this.threshold = o.threshold;
    this.floor = o.floor;
    this.lowFrac = o.lowFrac;
    // THREE cascaded one-poles, not one. A single pole rolls off at only
    // 6 dB/octave, which leaves a loud cymbal at 2 kHz attenuated by ~22 dB:
    // still comfortably over the floor, so crashes read as kicks. Three poles
    // put it ~66 dB down, which is inaudible to the detector. Phase is
    // irrelevant here because we time the envelope, not the waveform.
    this.aLp = Math.exp((-2 * Math.PI * o.cutoffHz) / sampleRate);
    this.lp2 = 0;
    this.lp3 = 0;
    // The slow envelope starts at zero, so for its first time constant ANY
    // signal beats `threshold * slow` and the very first block fires. Stay
    // deaf until it has settled: in practice this is the moment the mic opens.
    this.warmup = Math.round((o.slowMs / 1000) * sampleRate);
    this.aFast = Math.exp(-1 / ((o.fastMs / 1000) * sampleRate));
    this.aSlow = Math.exp(-1 / ((o.slowMs / 1000) * sampleRate));
    // Attack slower than release, so a sustained swell is followed but a
    // 45 ms thump is not.
    this.aSlowAttack = Math.exp(-1 / (((o.slowMs * 0.6) / 1000) * sampleRate));
    this.refractory = Math.round((o.refractoryMs / 1000) * sampleRate);
    this.lp = 0;
    this.fast = 0;
    this.slow = 0;
    /** Peak follower on the UNFILTERED signal, for the spectral shape test. */
    this.wide = 0;
    this.sinceFire = this.refractory;
    /** Set by the host while the kit is playing its own kick, so the speakers
     * cannot retrigger the foot that just fired. */
    this.muteFor = 0;
  }

  /** Ignore input for `ms`. The app calls this when IT plays a kick: on
   * speakers the sample's own thump is a textbook stomp and would loop. */
  mute(ms) {
    this.muteFor = Math.max(this.muteFor, Math.round((ms / 1000) * this.sampleRate));
  }

  /**
   * Feed one block of mono samples.
   * @param {Float32Array|number[]} block
   * @returns {{ offset: number, velocity: number }|null} sample offset of the
   *   onset within this block, so the timestamp keeps sub-block resolution.
   */
  process(block) {
    let hit = null;
    for (let i = 0; i < block.length; i++) {
      this.lp = this.aLp * this.lp + (1 - this.aLp) * block[i];
      this.lp2 = this.aLp * this.lp2 + (1 - this.aLp) * this.lp;
      this.lp3 = this.aLp * this.lp3 + (1 - this.aLp) * this.lp2;
      const mag = Math.abs(this.lp3);

      // Both followers track PEAKS. This matters: `fast` is a peak-hold, so
      // if `slow` averaged instead, their steady-state ratio would sit near
      // 1/0.637 = 1.57 for any sustained tone and creep past the threshold on
      // nothing more than a swell. Comparing like with like makes the ratio
      // 1.0 whenever the level is steady, whatever the level is, which is
      // exactly the "only hear a RISE" property the detector is built on.
      //
      // `slow` is deliberately slow in BOTH directions. A fast attack would
      // let it chase the very transient it is the reference for.
      this.fast = Math.max(mag, this.aFast * this.fast);
      this.wide = Math.max(Math.abs(block[i]), this.aFast * this.wide);
      this.slow =
        mag > this.slow
          ? this.aSlowAttack * this.slow + (1 - this.aSlowAttack) * mag
          : this.aSlow * this.slow + (1 - this.aSlow) * mag;

      if (this.sinceFire < this.refractory) this.sinceFire++;
      if (this.warmup > 0) {
        this.warmup--;
        continue;
      }
      if (this.muteFor > 0) {
        this.muteFor--;
        continue;
      }
      if (
        hit === null &&
        this.sinceFire >= this.refractory &&
        this.fast > this.floor &&
        this.fast > this.threshold * this.slow &&
        this.fast > this.lowFrac * this.wide
      ) {
        this.sinceFire = 0;
        hit = {
          offset: i,
          // Loud stomps read harder. Log-ish so a stamp and a tap differ
          // without a stamp pinning every hit at 1.0.
          velocity: Math.max(
            0.25,
            Math.min(1, 0.25 + 0.75 * Math.log10(1 + this.fast / this.floor) / 1.4),
          ),
        };
      }
    }
    return hit;
  }
}
