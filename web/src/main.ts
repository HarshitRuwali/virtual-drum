/** App wiring (PLAN 9.2, 9.3): tracker -> streaming detection -> audio + UI.
 *
 * The detection path (StreamingDetector/HandState) is the SAME code the
 * parity gate runs; the browser only supplies frames and plays sounds.
 */
import { configFromDict, type Config } from "./config";
import { ZoneSet } from "./zones";
import { Tracker } from "./tracker";
import { StreamingDetector, type Hit } from "./detect";
import { DrumKit } from "./audio";
import { Metronome } from "./metronome";
import { draw, type UiState } from "./ui";
import { fitOffset, score } from "./score";

const MAX_HISTORY = 256;

async function load<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`failed to load ${url}: ${r.status}`);
  return (await r.json()) as T;
}

export async function startApp(): Promise<void> {
  const cfg: Config = configFromDict(await load("/config/default.json"));
  const zones = ZoneSet.fromDict(await load("/config/zones.json"));

  const video = document.getElementById("video") as HTMLVideoElement;
  const canvas = document.getElementById("zones") as HTMLCanvasElement;
  const status = document.getElementById("status") as HTMLSpanElement;
  const bpmSlider = document.getElementById("bpm") as HTMLInputElement;
  const bpmLabel = document.getElementById("bpm-label") as HTMLSpanElement;
  const metroBtn = document.getElementById("metro") as HTMLButtonElement;

  const ctx = new AudioContext();
  await ctx.resume();

  const tracker = new Tracker(cfg);
  status.textContent = "loading hand model…";
  await tracker.init("/assets/hand_landmarker.task");
  status.textContent = "starting camera…";
  await tracker.start(video);

  const kit = new DrumKit(ctx);
  kit.init();
  const metro = new Metronome(ctx);
  const detector = new StreamingDetector(cfg, zones);

  // Times grouped per zone at the CALL SITE (the Python reference scores flat
  // time lists; zones are a grouping concern, see py/vdrum/sweep.py).
  const observedByZone = new Map<string, number[]>();
  const expectedByZone = new Map<string, number[]>();
  const recentHits: UiState["recentHits"] = [];
  let lastBeatMs: number | null = null;
  let lastDtMs: number | null = null;
  let lastBiasMs: number | null = null;
  let lastMatched = 0;
  // Fitted calibration constant (PLAN 8). 0.0 until enough beats; it only
  // shifts the READOUT, never the stored history.
  let offsetMs = 0.0;

  const pushZone = (
    map: Map<string, number[]>,
    zone: string,
    t: number,
  ): void => {
    let arr = map.get(zone);
    if (arr === undefined) {
      arr = [];
      map.set(zone, arr);
    }
    arr.push(t);
    if (arr.length > MAX_HISTORY) arr.splice(0, arr.length - MAX_HISTORY);
  };

  function onHit(hit: Hit, zone: string | null): void {
    kit.play(zone);
    const now = performance.now();
    recentHits.push({ t_ms: now, zone: zone ?? "?", hand: hit.hand });
    if (recentHits.length > 8) recentHits.splice(0, recentHits.length - 8);

    if (zone === null) return;
    // Store the RAW reported time (peak + constant OFFSET_MS).
    pushZone(observedByZone, zone, hit.report_t_ms);

    const exp = expectedByZone.get(zone);
    if (exp === undefined || exp.length === 0) return; // e.g. kick in v1
    const obs = observedByZone.get(zone) as number[];
    const s = score(obs, exp.slice(-16), cfg.detection.match_window_ms);
    const fitted = fitOffset(obs, exp, cfg.detection.match_window_ms);
    if (fitted !== null) offsetMs = fitted;
    lastBiasMs = s.bias_ms;
    lastMatched = s.matched.length;

    // Per-hit readout = raw dt of THIS hit minus the fitted constant (PLAN 8).
    let bestD = Infinity;
    let lastRawDt: number | null = null;
    for (const [p, g] of s.matched) {
      const d = Math.abs(p - hit.report_t_ms);
      if (d < bestD) {
        bestD = d;
        lastRawDt = p - g;
      }
    }
    if (lastRawDt !== null) lastDtMs = lastRawDt - offsetMs;
  }

  metro.onBeat = (t_ms: number): void => {
    pushZone(expectedByZone, "snare", t_ms);
    lastBeatMs = t_ms;
  };

  // Kick via keyboard (PLAN 3.6): no foot in frame, and a faked hand-kick
  // would corrupt the timing data. Timestamp = keydown on the capture clock.
  window.addEventListener("keydown", (e: KeyboardEvent): void => {
    if (e.code !== "Space" || e.repeat) return;
    e.preventDefault();
    const t = performance.now();
    kit.play("kick");
    const rec = { t_ms: t, zone: "kick", hand: "foot" };
    recentHits.push(rec);
    if (recentHits.length > 8) recentHits.splice(0, recentHits.length - 8);
    pushZone(observedByZone, "kick", t); // no expected kicks in v1: record only
  });

  bpmSlider.addEventListener("input", (): void => {
    const bpm = Number(bpmSlider.value);
    metro.setBpm(bpm);
    bpmLabel.textContent = String(bpm);
  });
  metroBtn.addEventListener("click", (): void => {
    if (metro.isRunning) {
      metro.stop();
      metroBtn.textContent = "start metronome";
    } else {
      metro.start();
      metroBtn.textContent = "stop metronome";
    }
  });

  status.textContent = "running — strike a zone";

  function sizeCanvas(): void {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
  }
  sizeCanvas();
  window.addEventListener("resize", sizeCanvas);

  function loop(): void {
    const now = performance.now();
    const hands = tracker.detect();
    const seen = new Set<string>();
    for (const hd of hands) {
      seen.add(hd.hand);
      const hit = detector.step(now, hd.hand, 1, hd.conf, hd.x, hd.y, hd.scale);
      if (hit) onHit(hit, hit.zone);
    }
    for (const known of detector.knownHands()) {
      if (!seen.has(known)) {
        const hit = detector.commitAbsent(now, known);
        if (hit) onHit(hit, hit.zone);
      }
    }

    draw(
      {
        zones,
        nowMs: now,
        recentHits,
        lastBeatMs,
        lastDtMs,
        biasMs: lastBiasMs,
        matchedCount: lastMatched,
        bpm: metro.isRunning ? Number(bpmSlider.value) : 0,
      },
      canvas,
    );
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
}
