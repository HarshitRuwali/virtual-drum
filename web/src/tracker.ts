/** Hand tracking via MediaPipe (PLAN 9). Browser-only; the detection core
 * (detect.ts) never imports this.
 *
 * Emits raw, UN-mirrored normalized coordinates + scale + confidence, once per
 * CAMERA frame. Handedness is swapped here (PLAN 3.5): the model labels the
 * user's right hand "Left", so we map "Left" -> "R", "Right" -> "L" and never
 * mirror coordinates.
 *
 * THE FRAME CLOCK (PLAN 3.1). This module owns the frame loop precisely so
 * that every hit timestamp originates from one place and is a *capture* time,
 * never "whenever JS got round to it":
 *
 *   requestVideoFrameCallback  -> fires once per decoded camera frame, with
 *                                 metadata.captureTime (when the camera
 *                                 actually grabbed it) and presentationTime.
 *   requestAnimationFrame      -> fires at DISPLAY refresh, unrelated to the
 *                                 camera. Using its callback time adds up to a
 *                                 refresh interval of scheduling noise, and
 *                                 that noise lands in the readout as JITTER --
 *                                 the one metric PLAN 8 says you cannot
 *                                 calibrate away.
 *
 * rAF remains only as a fallback for browsers without rVFC, and says so at
 * runtime via `usingFrameClock` so the UI can be honest about it.
 */
import { FilesetResolver, HandLandmarker } from "@mediapipe/tasks-vision";

import type { Config } from "./config";

export interface RawHand {
  hand: string; // "L" | "R" (user's actual hand)
  x: number; // normalized, un-mirrored
  y: number;
  scale: number; // palm width in normalized units (depth proxy)
  conf: number;
}

/** Subset of VideoFrameCallbackMetadata we rely on. `captureTime` is present
 * for MediaStream (camera) sources and is the closest thing to ground truth. */
interface FrameMeta {
  presentationTime: number;
  expectedDisplayTime: number;
  mediaTime: number;
  captureTime?: number;
}

type RvfcVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (
    cb: (now: number, metadata: FrameMeta) => void,
  ) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

const WASM_LOCAL = "/wasm";
// Must match the installed @mediapipe/tasks-vision version: a mismatched wasm
// runtime against this JS API fails in confusing ways at first inference.
const WASM_CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";

export type FrameHandler = (hands: RawHand[], tMs: number) => void;

export class Tracker {
  private cfg: Config;
  private landmarker: HandLandmarker | null = null;
  private video: RvfcVideo | null = null;
  private stream: MediaStream | null = null;
  private lastVideoTime = -1;
  private lastMpTs = -1;
  private handle: number | null = null;
  private stopped = false;
  /** False when the browser lacks rVFC and we fell back to rAF (PLAN 3.1). */
  usingFrameClock = false;

  constructor(cfg: Config) {
    this.cfg = cfg;
  }

  async init(modelPath: string): Promise<void> {
    let fileset;
    try {
      fileset = await FilesetResolver.forVisionTasks(WASM_LOCAL);
    } catch {
      fileset = await FilesetResolver.forVisionTasks(WASM_CDN);
    }
    this.landmarker = await HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: modelPath, delegate: "GPU" },
      runningMode: "VIDEO",
      numHands: this.cfg.hand.num_hands,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
    });
  }

  async start(video: HTMLVideoElement): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      // 60 fps halves the peak->decision lag and the duplicate-frame rate
      // (PLAN 3.2); browsers silently fall back to 30 if unsupported.
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 60 },
        facingMode: "user",
      },
      audio: false,
    });
    video.srcObject = this.stream;
    await video.play();
    this.video = video as RvfcVideo;
  }

  /** Actual camera frame rate, once the track is live (for the UI / diagnostics). */
  get frameRate(): number | null {
    const s = this.stream?.getVideoTracks()[0]?.getSettings();
    return s?.frameRate ?? null;
  }

  /** Run `onFrame` once per CAMERA frame, with the capture-clock timestamp.
   * Returns a stop function. */
  run(onFrame: FrameHandler): () => void {
    const v = this.video;
    if (!v) throw new Error("Tracker.run() before start()");
    this.stopped = false;

    if (typeof v.requestVideoFrameCallback === "function") {
      this.usingFrameClock = true;
      const step = (now: number, md: FrameMeta): void => {
        if (this.stopped) return;
        // captureTime is the camera's own instant; presentationTime is when the
        // frame was submitted for composition. Either beats `now`.
        const tMs = md.captureTime ?? md.presentationTime ?? now;
        const hands = this.detectAt(tMs);
        if (hands !== null) onFrame(hands, tMs);
        this.handle = v.requestVideoFrameCallback!(step);
      };
      this.handle = v.requestVideoFrameCallback(step);
    } else {
      // Fallback only. Timestamps here are display-scheduling times, so the
      // timing readout carries extra jitter; the UI flags this.
      this.usingFrameClock = false;
      const step = (now: number): void => {
        if (this.stopped) return;
        const hands = this.detectAt(now);
        if (hands !== null) onFrame(hands, now);
        this.handle = requestAnimationFrame(step);
      };
      this.handle = requestAnimationFrame(step);
    }
    return () => {
      this.stopped = true;
      this.handle = null;
    };
  }

  /** Detect on the current frame. Returns null when the frame has NOT advanced,
   * so the caller can skip the state machine entirely rather than re-feeding it
   * a stale sample. */
  detectAt(tMs: number): RawHand[] | null {
    const v = this.video;
    const lm = this.landmarker;
    if (!v || !lm || v.readyState < 2) return null;
    if (v.currentTime === this.lastVideoTime) return null;
    this.lastVideoTime = v.currentTime;

    // MediaPipe VIDEO mode needs strictly increasing integer timestamps.
    const ts = Math.max(Math.round(tMs), this.lastMpTs + 1);
    this.lastMpTs = ts;

    const res = lm.detectForVideo(v, ts);
    const out: RawHand[] = [];
    const a = this.cfg.hand.palm_a;
    const b = this.cfg.hand.palm_b;
    for (let i = 0; i < res.landmarks.length; i++) {
      const lms = res.landmarks[i];
      const cat = res.handedness[i]?.[0];
      const name = cat?.categoryName;
      // Swap: un-mirrored image, model's "Left" is the user's RIGHT hand.
      const hand = name === "Left" ? "R" : name === "Right" ? "L" : "R";
      const dx = lms[b].x - lms[a].x;
      const dy = lms[b].y - lms[a].y;
      const scale = Math.sqrt(dx * dx + dy * dy);
      const t = lms[this.cfg.hand.track_landmark];
      out.push({ hand, x: t.x, y: t.y, scale, conf: cat?.score ?? 0.0 });
    }
    return out;
  }

  stop(): void {
    this.stopped = true;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.landmarker?.close();
    this.landmarker = null;
  }
}
