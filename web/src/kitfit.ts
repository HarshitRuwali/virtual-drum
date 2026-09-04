/** Fit the authored kit to the camera you actually have. APP LAYER ONLY.
 *
 * `config/zones.json` is authored in aspect-corrected X for a 16:9 frame, so
 * its coordinates span 0..1.778. A 4:3 webcam only ever produces X in
 * 0..1.333, which puts hi-hat and crash beyond anything a hand can reach: two
 * pieces are drawn, cannot be played, and the whole thing reads as a broken
 * detector rather than a geometry mistake.
 *
 * WHY THIS IS NOT IN `zones.ts`. `ZoneSet` and `detect()` are under the parity
 * gate (PLAN 7.2) and must stay bit-identical to the Python reference, which
 * replays fixtures at a fixed aspect. Rescaling inside them would make the two
 * implementations disagree the moment a camera was not 16:9, and the gate
 * would not notice because its fixtures are all 16:9. Same reasoning as
 * `fitOffset()` (PLAN 8): it changes what the live app uses, never what the
 * gate compares.
 */
import { ZoneSet, type Zone } from "./zones";

/** The aspect `config/zones.json` coordinates are written in. */
export const AUTHORED_ASPECT = 16 / 9;

/** Scale zone X so the kit occupies the same FRACTION of frame width on any
 * camera. Y is untouched: it is already plain normalized image y, independent
 * of aspect. */
export function fitZonesToAspect(zones: ZoneSet, aspect: number): ZoneSet {
  if (!Number.isFinite(aspect) || aspect <= 0) return zones;
  const k = aspect / AUTHORED_ASPECT;
  if (Math.abs(k - 1) < 1e-9) return zones;
  const scaled: Zone[] = zones.zones.map((z) => ({
    ...z,
    x0: z.x0 * k,
    x1: z.x1 * k,
  }));
  return new ZoneSet(scaled);
}

/** Fraction of frame width the kit occupies, as [left, right] in RAW x.
 *
 * MediaPipe needs a whole hand in frame to emit any landmark, so a piece
 * sitting in the outer tenth of the picture cannot be struck: the hand stops
 * being tracked before it arrives. This reports the authored margin so a
 * re-layout that quietly pushes a piece back out to the edge can be caught by
 * a test instead of by a person wondering why one drum never fires. */
export function rawXSpan(zones: ZoneSet, aspect: number): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const z of zones.zones) {
    lo = Math.min(lo, z.x0 / aspect);
    hi = Math.max(hi, z.x1 / aspect);
  }
  return [lo, hi];
}
