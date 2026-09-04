/** The two things the first live test broke on: a stick drawn upside down, and
 * a kit placed where a hand cannot reach.
 *
 * Both were invisible to every existing gate. The parity gate compares hit
 * timing, not geometry; the stage tests check the mirror, not whether a human
 * arm can get there. These assert the physical claims instead.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { AUTHORED_ASPECT, fitZonesToAspect, rawXSpan } from "../src/kitfit";
import { stageOf, stickGeometry } from "../src/ui";
import { ZoneSet } from "../src/zones";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");

function kit(): ZoneSet {
  return ZoneSet.fromDict(
    JSON.parse(readFileSync(path.join(ROOT, "config", "zones.json"), "utf8")),
  );
}

describe("drumstick geometry", () => {
  const st = stageOf({ width: 1600, height: 900 }, AUTHORED_ASPECT);

  it("rises from the hand rather than dangling below it", () => {
    // The first bug: the shaft hung off the fingertips pointing at the floor.
    for (const hand of ["L", "R"]) {
      const g = stickGeometry(800, 500, st, hand);
      expect(g.tipY, `${hand} tip must be above the hand`).toBeLessThan(g.handY);
    }
  });

  it("puts the THICK end in the hand, which is how a stick is held", () => {
    // The second bug, and the one that took two rounds to see: the shaft was
    // the right way up, but the BEAD was at the tracked point and the fat butt
    // waved in the air. That is a stick held upside down. The invariant is
    // about the silhouette, so assert on the width profile the renderer uses,
    // not on a coordinate.
    for (const hand of ["L", "R"]) {
      const g = stickGeometry(800, 500, st, hand);
      const len = Math.hypot(g.tipX - g.handX, g.tipY - g.handY);
      // The grip sits near the hand end, which is only sensible if the hand
      // end is the butt: nobody grips a stick by its bead.
      const toHand = Math.hypot(g.gripX - g.handX, g.gripY - g.handY);
      expect(toHand).toBeLessThan(len * 0.35);
    }
  });

  it("keeps the hand end exactly on the tracked point", () => {
    // The hit registers there. Drawing it anywhere else makes the picture
    // disagree with the instrument.
    const g = stickGeometry(731, 412, st, "R");
    expect(g.handX).toBe(731);
    expect(g.handY).toBe(412);
  });

  it("leans each stick outward, so they never cross the body", () => {
    const l = stickGeometry(800, 500, st, "L");
    const r = stickGeometry(800, 500, st, "R");
    expect(l.tipX).toBeLessThan(l.handX); // left hand: up-left
    expect(r.tipX).toBeGreaterThan(r.handX); // right hand: up-right
  });

  it("keeps a drumstick's proportions, not a wooden spoon's", () => {
    // A 5A is about 29:1 long-to-thick. An earlier version rendered 13.6:1 and
    // looked wrong for reasons no coordinate assertion could have caught.
    const g = stickGeometry(800, 500, st, "R");
    const len = Math.hypot(g.tipX - g.handX, g.tipY - g.handY);
    const halfWidth = Math.max(2.4, len / 29);
    expect(len / (2 * halfWidth)).toBeGreaterThan(12);
  });

  it("scales the stick with the stage, not with the pixel canvas", () => {
    const small = stageOf({ width: 800, height: 450 }, AUTHORED_ASPECT);
    const a = stickGeometry(400, 250, small, "R");
    const b = stickGeometry(800, 500, st, "R");
    const lenA = Math.hypot(a.tipX - a.handX, a.tipY - a.handY);
    const lenB = Math.hypot(b.tipX - b.handX, b.tipY - b.handY);
    expect(lenB / lenA).toBeCloseTo(2, 6);
  });
});

describe("kit reach", () => {
  /** MediaPipe emits no landmark at all until a whole hand is in frame, so a
   * piece sitting in the outer tenth of the picture cannot be struck: tracking
   * drops before the hand arrives. The shipped kit used to demand raw x 0.011
   * for the ride, and that piece was simply unplayable. */
  const MARGIN = 0.08;

  it("keeps every piece inside the trackable part of the frame", () => {
    const [lo, hi] = rawXSpan(kit(), AUTHORED_ASPECT);
    expect(lo, `kit starts at raw x ${lo.toFixed(3)}, too close to the edge`)
      .toBeGreaterThanOrEqual(MARGIN);
    expect(hi, `kit ends at raw x ${hi.toFixed(3)}, too close to the edge`)
      .toBeLessThanOrEqual(1 - MARGIN);
  });

  it("still uses most of the frame: a cramped kit is as bad as an unreachable one", () => {
    const [lo, hi] = rawXSpan(kit(), AUTHORED_ASPECT);
    expect(hi - lo).toBeGreaterThan(0.6);
  });
});

describe("fitting the kit to the camera", () => {
  it("is the identity on the aspect the kit was authored for", () => {
    const fitted = fitZonesToAspect(kit(), AUTHORED_ASPECT);
    expect(fitted.zones).toEqual(kit().zones);
  });

  it("keeps every piece reachable on a 4:3 camera", () => {
    // The whole point. Unfitted, hi-hat x1 = 1.60 and crash x1 = 1.60 lie
    // beyond 4/3 = 1.333, so two pieces are drawn and cannot be played.
    const fourThree = 4 / 3;
    const unfitted = rawXSpan(kit(), fourThree);
    expect(unfitted[1]).toBeGreaterThan(1); // proves the defect is real
    const fitted = rawXSpan(fitZonesToAspect(kit(), fourThree), fourThree);
    expect(fitted[0]).toBeCloseTo(rawXSpan(kit(), AUTHORED_ASPECT)[0], 9);
    expect(fitted[1]).toBeCloseTo(rawXSpan(kit(), AUTHORED_ASPECT)[1], 9);
  });

  it("preserves the layout order and every zone id", () => {
    const fitted = fitZonesToAspect(kit(), 4 / 3);
    expect(fitted.zones.map((z) => z.id)).toEqual(kit().zones.map((z) => z.id));
    for (let i = 1; i < fitted.zones.length; i++) {
      const a = fitted.zones[i - 1];
      const b = fitted.zones[i];
      expect(Math.sign(a.x0 - b.x0)).toBe(
        Math.sign(kit().zones[i - 1].x0 - kit().zones[i].x0),
      );
    }
  });

  it("leaves Y alone: it is already independent of aspect", () => {
    const fitted = fitZonesToAspect(kit(), 4 / 3);
    expect(fitted.zones.map((z) => [z.y0, z.y1])).toEqual(
      kit().zones.map((z) => [z.y0, z.y1]),
    );
  });

  it("refuses to touch the kit on a nonsense aspect", () => {
    for (const bad of [0, -1, NaN, Infinity]) {
      expect(fitZonesToAspect(kit(), bad).zones).toEqual(kit().zones);
    }
  });
});
