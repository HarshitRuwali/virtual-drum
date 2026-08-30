/** App wiring: camera -> detection -> sound + stage + readouts.
 *
 * TWO LOOPS, ON PURPOSE (PLAN 3.1).
 *
 *   detection  runs from `tracker.run()`, once per CAMERA frame, stamped with
 *              the capture time. Nothing about drawing can delay or jitter it.
 *   rendering  runs on requestAnimationFrame, at DISPLAY rate. It only reads
 *              state. A slow paint costs a dropped frame of animation, never a
 *              millisecond of timing accuracy.
 *
 * Merging them (the previous design) meant a hit's timestamp was "whenever the
 * compositor got round to calling us", which lands in the readout as jitter --
 * the one error PLAN 8 says calibration cannot remove.
 *
 * The detection path (StreamingDetector/HandState) is the SAME code the parity
 * gate runs; the browser only supplies frames and plays sounds.
 */
import { configFromDict, type Config } from "./config";
import { ZoneSet } from "./zones";
import { Tracker, type RawHand } from "./tracker";
import { StreamingDetector, type Hit } from "./detect";
import { DrumKit } from "./audio";
import { Metronome } from "./metronome";
import { draw, type HandDot, type HitFx, type UiState } from "./ui";
import { fitOffset, score } from "./score";

const MAX_HISTORY = 256;
/** Sticks linger this long after the last sighting, so a single dropped
 * detection does not make them blink. */
const HAND_TTL_MS = 220;
/** Full-scale deflection of the timing meter. */
const METER_MS = 60;
const GHOSTS = 14;

async function load<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`failed to load ${url}: ${r.status}`);
  return (await r.json()) as T;
}

function el<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`missing element #${id}`);
  return e as T;
}

export async function startApp(
  onStatus: (msg: string) => void = () => {},
): Promise<void> {
  const cfg: Config = configFromDict(await load("/config/default.json"));
  const zones = ZoneSet.fromDict(await load("/config/zones.json"));

  const video = el<HTMLVideoElement>("video");
  const canvas = el<HTMLCanvasElement>("stage");
  const bpmSlider = el<HTMLInputElement>("bpm");
  const bpmLabel = el<HTMLSpanElement>("bpm-label");
  const volSlider = el<HTMLInputElement>("vol");
  const metroBtn = el<HTMLButtonElement>("metro");
  const zonesBtn = el<HTMLButtonElement>("zones-btn");
  const lamps = Array.from(document.querySelectorAll<HTMLElement>(".lamp"));
  const dtEl = el("dt");
  const dtWord = el("dt-word");
  const dtSub = el("dt-sub");
  const needle = el("needle");
  const ghostBox = el("ghosts");
  const countsBox = el("counts");
  const bClock = el("b-clock");
  const bAudio = el("b-audio");
  const bCam = el("b-cam");

  // "interactive" asks the platform for the smallest output buffer it can
  // manage: the difference between a kit that feels connected and one that
  // feels like a video call.
  const ctx = new AudioContext({ latencyHint: "interactive" });
  await ctx.resume();

  const tracker = new Tracker(cfg);
  onStatus("loading hand model…");
  await tracker.init("/assets/hand_landmarker.task");
  onStatus("starting camera…");
  await tracker.start(video);

  const kit = new DrumKit(ctx);
  kit.init();
  kit.setVolume(Number(volSlider.value) / 100);
  const metro = new Metronome(ctx);
  const detector = new StreamingDetector(cfg, zones);

  // ---- state -------------------------------------------------------------

  const hits: HitFx[] = [];
  let handsSeen: HandDot[] = [];
  let handsSeenAt = 0;
  /** Last seen position per hand. `Hit` deliberately carries no coordinates --
   * it is under the parity gate and must stay identical to the Python
   * dataclass -- so the ripple origin is taken from the most recent frame for
   * that hand. It trails the true peak by the peak->report lead (OFFSET_MS,
   * ~25 ms), which is invisible at drawing resolution. */
  const lastPos = new Map<string, { x: number; y: number }>();

  /** ONE beat grid for the whole kit. The previous build only ever recorded
   * expected times for the snare, so five of six pieces silently scored
   * nothing. What is being measured is whether you struck ON the beat -- that
   * question does not depend on which drum you struck. */
  const expected: number[] = [];
  const observed: number[] = [];
  const counts = new Map<string, number>();
  /** Beats scheduled ~120 ms ahead by the audio clock, held until they are
   * actually audible so the lamps and the rim flash land ON the click. */
  const pendingBeats: Array<{ t: number; beat: number }> = [];

  let lastBeatMs: number | null = null;
  let lastDtMs: number | null = null;
  let recentDt: number[] = [];
  /** Fitted calibration constant (PLAN 8): it shifts the READOUT only, never
   * the stored history. */
  let offsetMs = 0;
  let showZones = false;
  let frameTimes: number[] = [];

  const push = (arr: number[], v: number): void => {
    arr.push(v);
    if (arr.length > MAX_HISTORY) arr.splice(0, arr.length - MAX_HISTORY);
  };

  // ---- hits --------------------------------------------------------------

  function record(
    zone: string | null,
    hand: string,
    velocity: number,
    tReport: number,
    x: number,
    y: number,
  ): void {
    kit.play(zone, velocity);
    hits.push({ t_ms: performance.now(), zone, hand, velocity, x, y });
    if (hits.length > 24) hits.splice(0, hits.length - 24);
    if (zone !== null) counts.set(zone, (counts.get(zone) ?? 0) + 1);

    push(observed, tReport);
    if (expected.length === 0) return;

    const s = score(observed, expected, cfg.detection.match_window_ms);
    const fitted = fitOffset(observed, expected, cfg.detection.match_window_ms);
    if (fitted !== null) offsetMs = fitted;

    // Per-hit readout: THIS hit's raw error, minus the fitted constant.
    let bestD = Infinity;
    let raw: number | null = null;
    for (const [p, g] of s.matched) {
      const d = Math.abs(p - tReport);
      if (d < bestD) {
        bestD = d;
        raw = p - g;
      }
    }
    if (raw === null || bestD > 1e-6) {
      // This strike matched no beat (a fill, or an off-grid note). Leave the
      // needle where it was rather than inventing a number for it.
      updateMeter(s.matched.length);
      return;
    }
    lastDtMs = raw - offsetMs;
    recentDt.push(lastDtMs);
    if (recentDt.length > GHOSTS) recentDt = recentDt.slice(-GHOSTS);
    updateMeter(s.matched.length);
  }

  function onHit(hit: Hit): void {
    const p = lastPos.get(hit.hand);
    record(hit.zone, hit.hand, hit.velocity, hit.report_t_ms, p?.x ?? 0, p?.y ?? 0);
  }

  // ---- detection loop (camera clock) -------------------------------------

  tracker.run((hands: RawHand[], tMs: number): void => {
    const seen = new Set<string>();
    for (const hd of hands) {
      seen.add(hd.hand);
      // Recorded BEFORE step(), so a hit fired by this frame reads this frame.
      lastPos.set(hd.hand, { x: hd.x, y: hd.y });
      const hit = detector.step(tMs, hd.hand, 1, hd.conf, hd.x, hd.y, hd.scale);
      if (hit) onHit(hit);
    }
    for (const known of detector.knownHands()) {
      if (!seen.has(known)) {
        const hit = detector.commitAbsent(tMs, known);
        if (hit) onHit(hit);
      }
    }
    if (hands.length > 0) {
      handsSeen = hands.map((h) => ({
        hand: h.hand,
        x: h.x,
        y: h.y,
        scale: h.scale,
        conf: h.conf,
      }));
      handsSeenAt = performance.now();
    }

    const now = performance.now();
    frameTimes.push(now);
    if (frameTimes.length > 120) frameTimes = frameTimes.slice(-120);
  });

  // ---- transport ---------------------------------------------------------

  metro.onBeat = (t_ms: number, beat: number): void => {
    push(expected, t_ms);
    pendingBeats.push({ t: t_ms, beat });
  };

  // Kick from the keyboard: no foot in frame, and a faked hand-kick would
  // corrupt the timing data it is supposed to measure.
  window.addEventListener("keydown", (e: KeyboardEvent): void => {
    if (e.code !== "Space" || e.repeat) return;
    e.preventDefault();
    const kickZone = zones.zones.find((z) => z.id === "kick");
    const x = kickZone ? (kickZone.x0 + kickZone.x1) / 2 : 0;
    const y = kickZone ? (kickZone.y0 + kickZone.y1) / 2 : 0;
    record("kick", "foot", 1, performance.now(), x, y);
  });

  bpmSlider.addEventListener("input", (): void => {
    const bpm = Number(bpmSlider.value);
    metro.setBpm(bpm);
    bpmLabel.textContent = String(bpm);
  });
  volSlider.addEventListener("input", (): void => {
    kit.setVolume(Number(volSlider.value) / 100);
  });
  metroBtn.addEventListener("click", (): void => {
    if (metro.isRunning) {
      metro.stop();
      metroBtn.classList.remove("on");
      lamps.forEach((l) => l.classList.remove("on"));
    } else {
      // A fresh grid: beats from a previous run are not the same tempo.
      expected.length = 0;
      pendingBeats.length = 0;
      metro.setBpm(Number(bpmSlider.value));
      metro.start();
      metroBtn.classList.add("on");
    }
  });
  zonesBtn.addEventListener("click", (): void => {
    showZones = !showZones;
    zonesBtn.classList.toggle("on", showZones);
    zonesBtn.textContent = showZones ? "hide zones" : "show zones";
  });

  metroBtn.disabled = false;
  bpmSlider.disabled = false;
  volSlider.disabled = false;
  zonesBtn.disabled = false;
  onStatus("running");

  // ---- readouts ----------------------------------------------------------

  function pct(dt: number): number {
    const c = Math.max(-METER_MS, Math.min(METER_MS, dt));
    return 50 + (c / METER_MS) * 50;
  }

  function updateMeter(matched: number): void {
    if (lastDtMs === null) return;
    const dt = lastDtMs;
    const mag = Math.abs(dt);
    const color = mag < 15 ? "var(--good)" : mag < 35 ? "var(--warn)" : "var(--bad)";
    dtEl.textContent = `${dt >= 0 ? "+" : ""}${dt.toFixed(1)}`;
    dtEl.style.color = color;
    dtWord.textContent = mag < 15 ? "in the pocket" : dt < 0 ? "early" : "late";
    dtWord.style.color = color;
    needle.style.left = `${pct(dt)}%`;

    const n = recentDt.length;
    const mean = recentDt.reduce((a, b) => a + b, 0) / Math.max(1, n);
    const sd =
      n > 1
        ? Math.sqrt(
            recentDt.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1),
          )
        : NaN;
    // Spread is the skill number; the fitted offset is a constant of the rig
    // (PLAN 8). Reporting them together but labelled apart is the whole point.
    dtSub.innerHTML =
      `spread ${Number.isNaN(sd) ? "--" : `±${sd.toFixed(1)} ms`}<br />` +
      `cal ${offsetMs >= 0 ? "+" : ""}${offsetMs.toFixed(1)} ms · ${matched} beats`;

    ghostBox.replaceChildren(
      ...recentDt.map((g) => {
        const d = document.createElement("div");
        d.className = "ghost";
        d.style.left = `${pct(g)}%`;
        return d;
      }),
    );
  }

  const countRows = new Map<string, HTMLElement>();
  for (const z of zones.zones) {
    const row = document.createElement("div");
    row.className = "count";
    row.innerHTML = `<span>${z.id}</span><i>0</i>`;
    countsBox.appendChild(row);
    countRows.set(z.id, row);
  }

  function badge(node: HTMLElement, label: string, value: string, ok: boolean): void {
    node.innerHTML = `${label} <b>${value}</b>`;
    node.classList.toggle("ok", ok);
    node.classList.toggle("degraded", !ok);
  }

  function updateBadges(now: number): void {
    badge(
      bClock,
      "clock",
      tracker.usingFrameClock ? "frame" : "rAF",
      tracker.usingFrameClock,
    );
    const lat = metro.outputLatencyMs;
    badge(
      bAudio,
      "audio",
      metro.hasOutputTimestamp
        ? `synced ${lat.toFixed(0)}ms`
        : `estimated ${lat.toFixed(0)}ms`,
      metro.hasOutputTimestamp,
    );
    const win = frameTimes.filter((t) => now - t < 1000);
    const fps = win.length;
    const declared = tracker.frameRate;
    badge(
      bCam,
      "cam",
      `${fps} fps${declared ? ` / ${Math.round(declared)}` : ""}`,
      fps >= 24,
    );
  }

  // ---- render loop (display clock) ---------------------------------------

  function sizeCanvas(): void {
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
  }
  sizeCanvas();
  window.addEventListener("resize", sizeCanvas);

  let hudAt = 0;
  function frame(): void {
    const now = performance.now();

    // Release beats that have become audible.
    while (pendingBeats.length > 0 && pendingBeats[0].t <= now) {
      const b = pendingBeats.shift() as { t: number; beat: number };
      lastBeatMs = b.t;
      const idx = ((b.beat % 4) + 4) % 4;
      lamps.forEach((l, i) => l.classList.toggle("on", i === idx));
    }

    const state: UiState = {
      zones,
      aspect: tracker.aspect,
      nowMs: now,
      hits,
      hands: now - handsSeenAt < HAND_TTL_MS ? handsSeen : [],
      video,
      showZones,
      lastBeatMs,
    };
    draw(state, canvas);

    // The HUD is text: 10 Hz is plenty, and it keeps layout work off the
    // frames where the kit is animating.
    if (now - hudAt > 100) {
      hudAt = now;
      updateBadges(now);
      for (const [id, row] of countRows) {
        const c = counts.get(id) ?? 0;
        const i = row.querySelector("i");
        if (i && i.textContent !== String(c)) i.textContent = String(c);
        const lit = hits.some(
          (h) => h.zone === id && now - h.t_ms < 220,
        );
        row.classList.toggle("lit", lit);
      }
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
