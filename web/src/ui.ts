/** Canvas overlay UI (PLAN 9.2): zone boxes, hit flashes, beat pulse,
 * and the per-hit timing readout. Pure drawing -- no audio, no detection.
 *
 * Zones live in aspect-corrected normalized space (X = x * W/H, Y = y),
 * assumed 16:9; the canvas maps them back to pixels for display only.
 */

import type { Zone, ZoneSet } from "./zones";

export interface UiState {
  zones: ZoneSet;
  nowMs: number;
  recentHits: Array<{ t_ms: number; zone: string; hand: string }>;
  lastBeatMs: number | null;
  lastDtMs: number | null;
  biasMs: number | null;
  matchedCount: number;
  bpm: number;
}

const FLASH_MS = 180;
const BEAT_PULSE_MS = 250;

function zoneRect(z: Zone, w: number, h: number): [number, number, number, number] {
  const px0 = (z.x0 * h) / w;
  const px1 = (z.x1 * h) / w;
  return [px0 * w, z.y0 * h, (px1 - px0) * w, (z.y1 - z.y0) * h];
}

export function draw(state: UiState, canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  // Zones
  for (const z of state.zones.zones) {
    const [x, y, zw, zh] = zoneRect(z, w, h);
    const hit = state.recentHits.find(
      (r) => r.zone === z.id && state.nowMs - r.t_ms < FLASH_MS,
    );
    const flashing = hit !== undefined;
    ctx.fillStyle = flashing ? "rgba(80, 220, 120, 0.35)" : "rgba(120, 160, 255, 0.10)";
    ctx.strokeStyle = flashing ? "rgba(80, 220, 120, 0.95)" : "rgba(120, 160, 255, 0.45)";
    ctx.lineWidth = flashing ? 4 : 2;
    ctx.fillRect(x, y, zw, zh);
    ctx.strokeRect(x, y, zw, zh);
    ctx.fillStyle = flashing ? "#baffce" : "#9db4ff";
    ctx.font = `${Math.max(14, h / 40)}px system-ui, sans-serif`;
    ctx.fillText(z.id.toUpperCase(), x + 10, y + 26);
  }

  // Beat pulse (top-left)
  if (state.lastBeatMs !== null) {
    const age = state.nowMs - state.lastBeatMs;
    if (age >= 0 && age < BEAT_PULSE_MS) {
      const r = 8 + 26 * (1 - age / BEAT_PULSE_MS);
      ctx.beginPath();
      ctx.arc(26, 26, r, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255, 210, 80, 0.8)";
      ctx.fill();
    }
  }

  // Readout (top-right)
  const lines: Array<{ text: string; color: string }> = [];
  if (state.lastDtMs !== null) {
    const dt = state.lastDtMs;
    const color =
      Math.abs(dt) < 20 ? "#4ade80" : Math.abs(dt) < 50 ? "#facc15" : "#f87171";
    lines.push({
      text: `${dt >= 0 ? "+" : ""}${dt.toFixed(1)} ms`,
      color,
    });
  }
  if (state.biasMs !== null) {
    // The bias is a calibration constant (PLAN 8), not a skill metric --
    // label it as such, and report it separately from the per-hit error.
    lines.push({
      text: `cal ${state.biasMs >= 0 ? "+" : ""}${state.biasMs.toFixed(1)} ms / ${state.matchedCount} beats`,
      color: "#cbd5e1",
    });
  }
  lines.push({ text: `${state.bpm} bpm`, color: "#94a3b8" });
  lines.push({ text: "SPACE = kick", color: "#64748b" });

  ctx.font = `${Math.max(14, h / 34)}px system-ui, sans-serif`;
  let y = 30;
  for (const line of lines) {
    ctx.fillStyle = line.color;
    ctx.textAlign = "right";
    ctx.fillText(line.text, w - 14, y);
    y += Math.max(20, h / 26);
  }
  ctx.textAlign = "left";
}
