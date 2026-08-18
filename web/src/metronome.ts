/** Metronome with a WebAudio lookahead scheduler (PLAN 9.3).
 *
 * The WebAudio clock is the time base (drift-free); JS setInterval only
 * decides WHICH beat to schedule, 120 ms ahead. Each scheduled beat also
 * reports its instant on the performance.now() capture clock so scoring
 * can compare beats and hits on ONE timeline (PLAN 7.3).
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
  /** performance.now() at the moment ctx.currentTime was 0 (clock bridge). */
  private audioEpochMs: number;
  onBeat: ((t_ms: number, beat: number) => void) | null = null;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.audioEpochMs = performance.now() - ctx.currentTime * 1000;
  }

  get isRunning(): boolean {
    return this.running;
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
      this.onBeat?.(this.nextTime * 1000 + this.audioEpochMs, this.beat);
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
