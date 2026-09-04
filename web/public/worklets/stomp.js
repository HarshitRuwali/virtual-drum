/** AudioWorklet shell around StompDetector. Deliberately thin: everything
 * worth testing lives in stompcore.js, which node can import directly. */
import { StompDetector } from "./stompcore.js";

class StompProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.det = new StompDetector(sampleRate, options?.processorOptions ?? {});
    this.port.onmessage = (e) => {
      if (e.data?.type === "mute") this.det.mute(e.data.ms);
    };
  }

  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    const hit = this.det.process(ch);
    if (hit) {
      // `currentTime` is the AudioContext time at the START of this block, so
      // adding the intra-block offset keeps sub-block resolution: at 48 kHz a
      // 128-sample block is 2.7 ms, which is the difference between "on the
      // beat" and "noticeably late" in the readout this feeds.
      this.port.postMessage({
        t: currentTime + hit.offset / sampleRate,
        velocity: hit.velocity,
      });
    }
    return true;
  }
}

registerProcessor("stomp", StompProcessor);
