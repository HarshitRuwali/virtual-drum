/** A backing track to practise against.
 *
 * Routed through the app's own AudioContext rather than an <audio> element, so
 * the song, the metronome click and the kit all sit on ONE clock. That is not
 * decoration: the whole output of this tool is a millisecond error against a
 * beat grid, and an <audio> element runs on its own clock with its own
 * buffering, so a grid aligned to it would drift against the thing measuring
 * it.
 *
 * The file is read locally with decodeAudioData and never leaves the machine,
 * which is the same promise the camera path makes.
 */

export class BackingTrack {
  private ctx: AudioContext;
  private gain: GainNode;
  private buf: AudioBuffer | null = null;
  private src: AudioBufferSourceNode | null = null;
  /** AudioContext time at which song position 0 was scheduled. */
  private startedAt = 0;

  name: string | null = null;
  loop = true;
  onEnded: (() => void) | null = null;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.gain = ctx.createGain();
    this.gain.gain.value = 0.7;
    this.gain.connect(ctx.destination);
  }

  get loaded(): boolean {
    return this.buf !== null;
  }

  get playing(): boolean {
    return this.src !== null;
  }

  get duration(): number {
    return this.buf?.duration ?? 0;
  }

  /** Seconds into the song, or 0 when stopped. */
  get position(): number {
    if (!this.src || !this.buf) return 0;
    const t = this.ctx.currentTime - this.startedAt;
    return this.loop && this.buf.duration > 0 ? t % this.buf.duration : t;
  }

  async load(file: File): Promise<void> {
    // decodeAudioData detaches the ArrayBuffer it is given, so a retry with
    // the same buffer would fail with a confusing "detached" error.
    const bytes = await file.arrayBuffer();
    this.buf = await this.ctx.decodeAudioData(bytes);
    this.name = file.name;
  }

  /** Start from the top. Returns the AudioContext time it will begin, so the
   * caller can align a beat grid to song position zero. */
  start(): number {
    if (!this.buf) return 0;
    this.stop();
    const src = this.ctx.createBufferSource();
    src.buffer = this.buf;
    src.loop = this.loop;
    src.connect(this.gain);
    // A small lead: scheduling at exactly currentTime asks the graph to start
    // in the past, which some implementations round up unpredictably. Anything
    // aligned to this start time must use the SAME value, hence returning it.
    const at = this.ctx.currentTime + 0.06;
    src.onended = (): void => {
      if (this.src === src) {
        this.src = null;
        this.onEnded?.();
      }
    };
    src.start(at);
    this.src = src;
    this.startedAt = at;
    return at;
  }

  stop(): void {
    if (!this.src) return;
    const src = this.src;
    // Clear this.src BEFORE stopping. stop() synchronously fires onended, and
    // the handler's `this.src === src` test is what distinguishes "the song
    // reached its end" from "the user pressed stop": without this ordering,
    // every pause would report the song as finished and reset the transport.
    this.src = null;
    try {
      src.stop();
    } catch {
      // Already stopped; nothing to do.
    }
    src.disconnect();
  }

  setVolume(v: number): void {
    // Ramp, never assign: a step on a gain node is an audible click.
    this.gain.gain.linearRampToValueAtTime(
      Math.max(0, Math.min(1, v)),
      this.ctx.currentTime + 0.02,
    );
  }
}
