/** Hand tracking via MediaPipe (PLAN 9.2). Browser-only; the detection core
 * (detect.ts) never imports this.
 *
 * Emits raw, UN-mirrored normalized coordinates + scale + confidence, once
 * per video frame, on the performance.now() capture clock. Handedness is
 * swapped here (PLAN 3.5): the model labels the user's right hand "Left",
 * so we map "Left" -> "R", "Right" -> "L" and never mirror coordinates.
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

const WASM_LOCAL = "/wasm";
const WASM_CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";

export class Tracker {
  private cfg: Config;
  private landmarker: HandLandmarker | null = null;
  private video: HTMLVideoElement | null = null;
  private stream: MediaStream | null = null;
  private lastVideoTime = -1;
  private lastResult: RawHand[] = [];

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
      video: { width: 1280, height: 720, facingMode: "user" },
      audio: false,
    });
    video.srcObject = this.stream;
    await video.play();
    this.video = video;
  }

  stop(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.landmarker?.close();
    this.landmarker = null;
  }

  /** Detect on the current video frame. Returns [] if no new frame arrived
   * (MediaPipe requires strictly increasing frame times). */
  detect(): RawHand[] {
    const v = this.video;
    const lm = this.landmarker;
    if (!v || !lm || v.readyState < 2) return [];
    if (v.currentTime === this.lastVideoTime) return this.lastResult;
    this.lastVideoTime = v.currentTime;

    const res = lm.detectForVideo(v, performance.now());
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
      out.push({
        hand,
        x: t.x,
        y: t.y,
        scale: scale,
        conf: cat?.score ?? 0.0,
      });
    }
    this.lastResult = out;
    return out;
  }
}
