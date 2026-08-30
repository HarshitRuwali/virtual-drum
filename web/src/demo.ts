/** Camera-free demo of the stage (`index.html?demo`).
 *
 * Two jobs. It lets someone see the kit before deciding whether to hand a web
 * page their webcam, and -- the reason it exists -- it makes the RENDERER
 * reviewable on a machine with no camera at all, which is where this project
 * is developed (PLAN 1). Everything below the drawing layer is faked; nothing
 * here is imported by the real app.
 */
import { configFromDict, type Config } from "./config";
import { DrumKit } from "./audio";
import { draw, type HandDot, type HitFx, type UiState } from "./ui";
import { ZoneSet } from "./zones";

const BPM = 92;
const STEP_MS = 60000 / BPM / 2; // eighth notes

/** One bar of eighths: which pieces fire, and how hard. */
const PATTERN: Array<Array<[string, number]>> = [
  [["kick", 1.0], ["hi-hat", 0.8], ["crash", 0.9]],
  [["hi-hat", 0.35]],
  [["snare", 0.95], ["hi-hat", 0.6]],
  [["hi-hat", 0.3]],
  [["kick", 0.9], ["hi-hat", 0.75]],
  [["hi-hat", 0.35], ["ride", 0.5]],
  [["snare", 1.0], ["hi-hat", 0.6]],
  [["tom", 0.7], ["hi-hat", 0.3]],
];

/** Which hand plays what, and therefore which stick swings where. */
const HAND: Record<string, string> = {
  "hi-hat": "L",
  crash: "L",
  snare: "R",
  tom: "R",
  ride: "R",
  kick: "foot",
};

async function load<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`failed to load ${url}: ${r.status}`);
  return (await r.json()) as T;
}

export async function startDemo(
  onStatus: (msg: string) => void = () => {},
): Promise<void> {
  const cfg: Config = configFromDict(await load("/config/default.json"));
  const zones = ZoneSet.fromDict(await load("/config/zones.json"));
  void cfg;

  const canvas = document.getElementById("stage") as HTMLCanvasElement;
  const lamps = Array.from(document.querySelectorAll<HTMLElement>(".lamp"));
  // The badges must not claim a measurement that is not being taken here.
  const badge = (id: string, text: string): void => {
    const n = document.getElementById(id);
    if (n) {
      n.innerHTML = text;
      n.classList.remove("ok");
      n.classList.add("degraded");
    }
  };
  badge("b-clock", "clock <b>demo</b>");
  badge("b-audio", "audio <b>demo</b>");
  badge("b-cam", "cam <b>off</b>");
  const ctx = new AudioContext({ latencyHint: "interactive" });
  await ctx.resume();
  const kit = new DrumKit(ctx);
  kit.init();
  kit.setVolume(0.7);

  const centre = new Map<string, { x: number; y: number }>();
  for (const z of zones.zones) {
    centre.set(z.id, { x: (z.x0 + z.x1) / 2, y: (z.y0 + z.y1) / 2 });
  }

  // Counters, so the top strip is not a conspicuous empty gap in demo mode.
  const countsBox = document.getElementById("counts");
  const countRows = new Map<string, HTMLElement>();
  const counts = new Map<string, number>();
  if (countsBox) {
    countsBox.replaceChildren(
      ...zones.zones.map((z) => {
        const row = document.createElement("div");
        row.className = "count";
        row.innerHTML = `<span>${z.id}</span><i>0</i>`;
        countRows.set(z.id, row);
        return row;
      }),
    );
  }

  const hits: HitFx[] = [];
  let lastBeatMs: number | null = null;
  let step = -1;
  const t0 = performance.now();

  // Where each stick is heading, and where it came from.
  const target: Record<string, { x: number; y: number }> = {
    L: centre.get("hi-hat") ?? { x: 1.4, y: 0.6 },
    R: centre.get("snare") ?? { x: 0.9, y: 0.67 },
  };
  const from: Record<string, { x: number; y: number }> = {
    L: { ...target.L },
    R: { ...target.R },
  };
  let stepAt = t0;

  function sizeCanvas(): void {
    const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
  }
  sizeCanvas();
  window.addEventListener("resize", sizeCanvas);
  onStatus("demo: no camera in use");

  function frame(): void {
    const now = performance.now();
    const want = Math.floor((now - t0) / STEP_MS);

    while (step < want) {
      step++;
      stepAt = t0 + step * STEP_MS;
      const bar = Math.floor(step / 8);
      for (const [zone, vel] of PATTERN[step % 8]) {
        // The crash is a downbeat-of-the-phrase accent, not every bar.
        if (zone === "crash" && bar % 4 !== 0) continue;
        if (zone === "ride" && bar % 2 === 0) continue;
        const c = centre.get(zone);
        if (!c) continue;
        const hand = HAND[zone] ?? "R";
        hits.push({
          t_ms: stepAt,
          zone,
          hand,
          velocity: vel,
          x: c.x + (Math.random() - 0.5) * 0.05,
          y: c.y + (Math.random() - 0.5) * 0.03,
        });
        kit.play(zone, vel);
        counts.set(zone, (counts.get(zone) ?? 0) + 1);
        if (hand === "L" || hand === "R") {
          from[hand] = { ...target[hand] };
          target[hand] = c;
        }
      }
      if (step % 2 === 0) {
        lastBeatMs = stepAt;
        const idx = (step / 2) % 4;
        lamps.forEach((l, i) => l.classList.toggle("on", i === idx));
      }
      if (hits.length > 24) hits.splice(0, hits.length - 24);
    }

    // Sticks travel to the next target and bounce off the head on arrival.
    const k = Math.max(0, Math.min(1, (now - stepAt) / STEP_MS));
    const hands: HandDot[] = (["L", "R"] as const).map((h) => {
      const ease = k * k * (3 - 2 * k);
      const lift = Math.sin(Math.PI * k) * 0.06;
      return {
        hand: h,
        x: from[h].x + (target[h].x - from[h].x) * ease,
        y: from[h].y + (target[h].y - from[h].y) * ease - lift,
        scale: 0.1,
        conf: 0.95,
      };
    });

    for (const [id, row] of countRows) {
      const i = row.querySelector("i");
      const c = String(counts.get(id) ?? 0);
      if (i && i.textContent !== c) i.textContent = c;
      row.classList.toggle(
        "lit",
        hits.some((h) => h.zone === id && now - h.t_ms < 220),
      );
    }

    const state: UiState = {
      zones,
      aspect: 16 / 9,
      nowMs: now,
      hits,
      hands,
      video: null,
      showZones: false,
      lastBeatMs,
    };
    draw(state, canvas);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
