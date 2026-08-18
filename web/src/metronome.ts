/** Metronome with a WebAudio lookahead scheduler (PLAN 6.3).
 *
 * The WebAudio clock is the time base; setInterval only decides WHICH beat to
 * schedule, ~120 ms ahead. Beat instants are then reported on the
 * performance.now() timeline so hits and beats can be compared on ONE clock.
 *
 * THE CLOCK BRIDGE (PLAN 3.1, 8). Mapping audio time -> performance time must
 * use `AudioContext.getOutputTimestamp()`, re-sampled every tick. That API
 * exists exactly for this: its `contextTime` is the sample frame currently
 * leaving the output device, paired with the `performanceTime` at which that
 * happened -- so the mapping is inherently OUTPUT-LATENCY COMPENSATED and
 * tracks drift between the audio hardware clock and the system clock.
 *
 * Sampling `performance.now() - currentTime * 1000` once in the constructor
 * (what this used to do) gets both wrong: it ignores output latency entirely,
 * so every beat is reported earlier than it is audible, and it cannot follow
 * clock drift, so the error grows across a practice session. A constant error
 * would at least calibrate out as bias (PLAN 8); drift does not.
 */

const AHEAD_S = 0.12;
const TICK_MS = 25;

export class Metronome {
  private ctx: AudioContext;
  private running = false;
  private nextTime = 0;
  private beat = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private bpm = 60;
  /** Fallback bridge only, used when getOutputTimestamp() is unavailable. */
  private audioEpochMs: number;
  onBeat: ((t_ms: number, beat: number) => void) | null = null;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.audioEpochMs = performance.now() - ctx.currentTime * 1000;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Total output latency in ms (base + device), 0 when unreported. */
  get outputLatencyMs(): number {
    const base = this.ctx.baseLatency ?? 0;
    const out = (this.ctx as AudioContext & { outputLatency?: number }).outputLatency ?? 0;
    return (base + out) * 1000;
  }

  /** True when the precise clock bridge is available (UI honesty). */
  get hasOutputTimestamp(): boolean {
    const ots = this.ctx.getOutputTimestamp?.();
    return !!ots && ots.contextTime > 0;
  }

  /** Audio-context time -> performance.now() time, latency compensated. */
  perfTimeForContextTime(t: number): number {
    const ots = this.ctx.getOutputTimestamp?.();
    if (ots && ots.contextTime > 0 && ots.performanceTime > 0) {
      return ots.performanceTime + (t - ots.contextTime) * 1000;
    }
    // Fallback: fixed epoch, with output latency added by hand so the reported
    // instant is when the click is AUDIBLE rather than when it was scheduled.
    return this.audioEpochMs + t * 1000 + this.outputLatencyMs;
  }

  setBpm(bpm: number): void {
    this.bpm = Math.max(20, Math.min(240, Math.round(bpm)));
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.beat = 0;
    this.nextTime = this.ctx.currentTime + 0.1;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    if (!this.running) return;
    const horizon = this.ctx.currentTime + AHEAD_S;
    while (this.nextTime < horizon) {
      const accent = this.beat % 4 === 0;
      this.beep(this.nextTime, accent);
      this.onBeat?.(this.perfTimeForContextTime(this.nextTime), this.beat);
      this.beat++;
      this.nextTime += 60 / this.bpm;
    }
  }

  private beep(t: number, accent: boolean): void {
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.frequency.value = accent ? 1568 : 1046;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(accent ? 0.5 : 0.28, t + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    o.connect(g);
    g.connect(this.ctx.destination);
    o.start(t);
    o.stop(t + 0.06);
  }
}
