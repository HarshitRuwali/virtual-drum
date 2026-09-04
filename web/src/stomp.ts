/** Kick from a real foot: stomp detection over the microphone.
 *
 * The space bar was always a compromise (PLAN 6.2). You cannot press it while
 * both hands are in the air, which is the entire posture the app is played in,
 * so in practice the kick either does not get played or a hand leaves the kit
 * to play it. This gives the foot back to the foot.
 *
 * It is also the most accurate input in the app. A stomp arrives through the
 * same AudioContext the kit plays out of, so its timestamp needs no bridge
 * from the camera clock, and the detector resolves the onset to a sample
 * rather than to a video frame.
 */
import { audioToPerf } from "./clock";

export interface StompHit {
  /** performance.now() domain, ready for record(). */
  tMs: number;
  velocity: number;
}

export class StompInput {
  private ctx: AudioContext;
  private node: AudioWorkletNode | null = null;
  private stream: MediaStream | null = null;
  /** Last failure, for the badge: silent failure here looks like a dead foot. */
  error: string | null = null;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
  }

  get running(): boolean {
    return this.node !== null;
  }

  async start(onStomp: (h: StompHit) => void): Promise<boolean> {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          // Echo cancellation is the whole defence against the speakers
          // retriggering the kick they just played. autoGainControl would
          // fight the envelope detector by normalising the very transient it
          // keys on, and noiseSuppression eats low-frequency thumps.
          echoCancellation: true,
          autoGainControl: false,
          noiseSuppression: false,
        },
        video: false,
      });
      await this.ctx.audioWorklet.addModule("/worklets/stomp.js");
      const src = this.ctx.createMediaStreamSource(this.stream);
      this.node = new AudioWorkletNode(this.ctx, "stomp");
      this.node.port.onmessage = (e: MessageEvent): void => {
        const d = e.data as { t: number; velocity: number };
        onStomp({ tMs: audioToPerf(this.ctx, d.t), velocity: d.velocity });
      };
      // Deliberately NOT connected to the destination: this is an input tap,
      // and routing a live mic to the speakers is a feedback loop.
      src.connect(this.node);
      return true;
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      this.stop();
      return false;
    }
  }

  /** Deafen the detector briefly. The app calls this whenever IT plays a kick:
   * on speakers, the sample's own thump is a textbook stomp and would loop. */
  mute(ms: number): void {
    this.node?.port.postMessage({ type: "mute", ms });
  }

  stop(): void {
    this.node?.disconnect();
    this.node = null;
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = null;
  }
}
