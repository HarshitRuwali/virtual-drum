/** The stage: camera backdrop + a drawn drum kit + strike effects.
 *
 * COORDINATES. Zones live in aspect-corrected, UN-mirrored normalized space
 * (X = x * W/H so X spans 0..aspect; Y = y in 0..1) -- the same space the
 * detector matches in. The camera image is presented MIRRORED, because a
 * player who moves their left hand must see it move on the left. So every
 * zone is flipped exactly once, here, at render time (PLAN 3.5):
 *
 *     screen_x = stage.x + (aspect - X) * s
 *     screen_y = stage.y + Y * s
 *
 * The frame is letterboxed (`contain`, not `cover`) so the whole kit is
 * always on screen: cropping the sides would silently delete the ride and
 * the crash on a narrow window.
 *
 * WHAT IS DRAWN VS WHAT IS HIT. Each piece is inscribed in its zone
 * RECTANGLE, so the drawn shell/cymbal is a little smaller than the region
 * that actually triggers it. That errs the forgiving way -- if you hit what
 * you see, you hit the zone -- and `showZones` renders the true rectangles
 * so the mismatch is inspectable during calibration rather than a mystery.
 *
 * Pure drawing: no audio, no detection, no DOM outside the canvas.
 */

import type { Zone, ZoneSet } from "./zones";

/** A strike to animate. `x`/`y` are the peak position in zone space, so the
 * ripple starts where the stick actually landed, not at the drum's centre. */
export interface HitFx {
  t_ms: number;
  zone: string | null;
  hand: string;
  velocity: number;
  x: number;
  y: number;
}

/** A tracked hand, in the same zone space. */
export interface HandDot {
  hand: string;
  x: number;
  y: number;
  scale: number;
  conf: number;
}

export interface UiState {
  zones: ZoneSet;
  /** Frame aspect (videoWidth/videoHeight); zone X spans 0..aspect. */
  aspect: number;
  nowMs: number;
  hits: HitFx[];
  hands: HandDot[];
  video: HTMLVideoElement | null;
  showZones: boolean;
  /** Beat instants (performance.now ms) for the rim flash on the count. */
  lastBeatMs: number | null;
}

/** How long a strike animates. Longer than the audio decay on purpose: the
 * eye needs the confirmation more than the ear does. */
const HIT_MS = 420;
const BEAT_MS = 160;

// ---------------------------------------------------------------------------
// Kit description: what each zone id looks like.
// ---------------------------------------------------------------------------

type Piece = "drum" | "cymbal" | "hihat" | "front";

interface Look {
  piece: Piece;
  /** Fraction of the zone's WIDTH the piece actually occupies. Well under 1:
   * a kit is pieces arranged in space, and a zone drawn edge to edge reads as
   * a tiled panel. The trigger area stays the full rectangle either way. */
  fit: number;
  /** Shell depth as a multiple of the head radius. A snare is shallow, a tom
   * is not, and getting this wrong is what makes a drawn drum look like a
   * bucket. */
  depth: number;
  /** Shell or bronze body, dark -> light -> dark across the cylinder. */
  body: [string, string, string];
  /** Drumhead / cymbal face. */
  face: string;
  /** The head at its NEAR edge. Barely darker than `face` on purpose: a real
   * head is close to flat, and a strong falloff reads as a cavity. */
  faceLow: string;
  /** Resting tilt in radians. Cymbals hang at an angle; drawing them dead
   * level is the difference between a cymbal and a coin. */
  tilt: number;
  /** Hoop, lugs, bell. */
  metal: string;
  /** Strike glow. */
  glow: string;
}

const LOOKS: Record<string, Look> = {
  kick: {
    faceLow: "#cbbda8",
    tilt: 0,
    fit: 0.86,
    depth: 0.0,
    piece: "front",
    body: ["#2a0910", "#a82c3e", "#160409"],
    face: "#f2e6d8",
    metal: "#d8dee9",
    glow: "#ff8a5c",
  },
  snare: {
    faceLow: "#d9d2c4",
    tilt: 0,
    fit: 0.72,
    depth: 0.62,
    piece: "drum",
    body: ["#333b46", "#eaf1f8", "#141a21"],
    face: "#f6f1e7",
    metal: "#e6ecf5",
    glow: "#7dd3fc",
  },
  tom: {
    faceLow: "#d6cab2",
    tilt: 0,
    fit: 0.72,
    depth: 0.82,
    piece: "drum",
    body: ["#3a1a0e", "#b06a3c", "#1d0c05"],
    face: "#f3ead9",
    metal: "#dce3ee",
    glow: "#fbbf24",
  },
  "hi-hat": {
    faceLow: "#e6d296",
    tilt: 0,
    fit: 0.80,
    depth: 0.0,
    piece: "hihat",
    body: ["#7a5a1c", "#f0d178", "#6b4c14"],
    face: "#f7e6a8",
    metal: "#c9b06a",
    glow: "#fde68a",
  },
  crash: {
    faceLow: "#e8d79c",
    tilt: -0.1,
    fit: 0.86,
    depth: 0.0,
    piece: "cymbal",
    body: ["#8a6420", "#ffe9a3", "#77531a"],
    face: "#ffeeb0",
    metal: "#d4b871",
    glow: "#fff2bf",
  },
  ride: {
    faceLow: "#d4bd78",
    tilt: 0.07,
    fit: 0.86,
    depth: 0.0,
    piece: "cymbal",
    body: ["#6f5119", "#e0c274", "#5c4214"],
    face: "#ecd58c",
    metal: "#bf9f57",
    glow: "#ffe9a8",
  },
};

const FALLBACK: Look = {
  faceLow: "#c9ccd4",
  tilt: 0,
  fit: 0.72,
  depth: 0.7,
  piece: "drum",
  body: ["#3f4451", "#8f9aad", "#33373f"],
  face: "#e8e8ee",
  metal: "#cfd6e2",
  glow: "#a5b4fc",
};

// ---------------------------------------------------------------------------
// Stage geometry
// ---------------------------------------------------------------------------

export interface Stage {
  /** Letterboxed frame rect, in device pixels. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Pixels per normalized unit (h, since Y spans 0..1). */
  s: number;
  aspect: number;
}

export function stageOf(canvas: { width: number; height: number }, aspect: number): Stage {
  const s = Math.min(canvas.width / aspect, canvas.height);
  const w = aspect * s;
  return {
    x: (canvas.width - w) / 2,
    y: (canvas.height - s) / 2,
    w,
    h: s,
    s,
    aspect,
  };
}

/** Zone space -> screen px, mirrored (PLAN 3.5). */
export function sx(st: Stage, X: number): number {
  return st.x + (st.aspect - X) * st.s;
}
export function sy(st: Stage, Y: number): number {
  return st.y + Y * st.s;
}

/** A zone's rectangle on screen. x1 maps to the LEFT edge because of the flip. */
export function rectOf(st: Stage, z: Zone): [number, number, number, number] {
  const left = sx(st, z.x1);
  const right = sx(st, z.x0);
  const top = sy(st, z.y0);
  return [left, top, right - left, sy(st, z.y1) - top];
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

function ellipsePath(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
): void {
  ctx.beginPath();
  ctx.ellipse(cx, cy, Math.max(0.5, rx), Math.max(0.5, ry), 0, 0, Math.PI * 2);
}

function radialGlow(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  color: string,
  alpha: number,
): void {
  if (alpha <= 0.002 || r <= 0) return;
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  g.addColorStop(0, color);
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.globalCompositeOperation = "lighter";
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

/** Stand tube. Dark: a bright rod reads as a light beam across the stage. */
function standTo(
  ctx: CanvasRenderingContext2D,
  cx: number,
  topY: number,
  bottomY: number,
  width: number,
): void {
  const g = ctx.createLinearGradient(cx - width, 0, cx + width, 0);
  g.addColorStop(0, "#171b22");
  g.addColorStop(0.4, "#5c6675");
  g.addColorStop(1, "#12151a");
  ctx.fillStyle = g;
  ctx.fillRect(cx - width / 2, topY, width, bottomY - topY);
}

/** A drum seen from slightly above: head, hoop, shell, lugs -- sized so the
 * head meets the hoop exactly. Leaving a gap between them is what turned the
 * first version into a bucket: the shell gradient showed through the ring and
 * read as an interior wall. */
function drawDrum(
  ctx: CanvasRenderingContext2D,
  r: [number, number, number, number],
  st: Stage,
  look: Look,
  amp: number,
  prog: number,
  strike: [number, number] | null,
): void {
  const [x, y, w, h] = r;
  const cx = x + w / 2;
  const rx = (w * look.fit) / 2;
  const ry = rx * 0.3;
  const depth = rx * look.depth;
  // Centre the whole cylinder in the zone rather than pinning it to the top,
  // so pieces of different depths still sit on a common visual line.
  const cy = y + (h - (2 * ry + depth)) / 2 + ry;

  radialGlow(ctx, cx, cy, rx * 2.1, look.glow, amp * (1 - prog) * 0.5);

  // Stand, drawn first so the shell hides where it meets the drum. A drum with
  // no visible support reads as floating no matter how well the shell is lit.
  standTo(ctx, cx, cy + depth, st.y + st.h, Math.max(2.5, rx * 0.05));
  ctx.beginPath();
  ctx.moveTo(cx - rx * 0.55, st.y + st.h);
  ctx.lineTo(cx, cy + depth + ry);
  ctx.lineTo(cx + rx * 0.55, st.y + st.h);
  ctx.strokeStyle = "rgba(92, 102, 117, 0.55)";
  ctx.lineWidth = Math.max(1.5, rx * 0.03);
  ctx.stroke();

  // Contact shadow: without it the kit floats.
  ellipsePath(ctx, cx, cy + depth + ry * 0.35, rx * 1.02, ry * 0.55);
  ctx.fillStyle = "rgba(0, 0, 0, 0.4)";
  ctx.fill();

  // Shell.
  const body = ctx.createLinearGradient(cx - rx, 0, cx + rx, 0);
  body.addColorStop(0, look.body[0]);
  body.addColorStop(0.34, look.body[1]);
  body.addColorStop(0.72, look.body[0]);
  body.addColorStop(1, look.body[2]);
  ctx.beginPath();
  ctx.ellipse(cx, cy + depth, rx, ry, 0, 0, Math.PI);
  ctx.lineTo(cx - rx, cy);
  ctx.ellipse(cx, cy, rx, ry, 0, Math.PI, 0, true);
  ctx.closePath();
  ctx.fillStyle = body;
  ctx.fill();

  // Lugs, on the lit half only: a full ring of them flattens the cylinder.
  ctx.save();
  ctx.fillStyle = look.metal;
  ctx.globalAlpha = 0.5;
  const lugs = 7;
  for (let i = 0; i < lugs; i++) {
    const a = Math.PI * ((i + 0.5) / lugs);
    const lx = cx - Math.cos(a) * rx * 0.84;
    const ly = cy + Math.sin(a) * ry * 0.84;
    const lw = Math.max(1.5, rx * 0.05);
    ctx.fillRect(lx - lw / 2, ly + depth * 0.16, lw, depth * 0.62);
  }
  ctx.restore();

  // Bottom hoop.
  ctx.beginPath();
  ctx.ellipse(cx, cy + depth, rx, ry, 0, 0, Math.PI);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.22)";
  ctx.lineWidth = Math.max(1.5, rx * 0.04);
  ctx.stroke();

  // Head, flush with the hoop. Dips on impact, then settles.
  const dip = 1 - 0.18 * amp * Math.max(0, 1 - prog * 2.2);
  const rh = ry * dip;
  // A LINEAR, low-contrast gradient. The first version used a bright radial
  // centre falling to a dark rim, which is exactly how you shade the inside of
  // a bowl -- and it made every drum look like an open bucket.
  const face = ctx.createLinearGradient(0, cy - rh, 0, cy + rh);
  face.addColorStop(0, look.face);
  face.addColorStop(0.55, look.face);
  face.addColorStop(1, look.faceLow);
  ellipsePath(ctx, cx, cy, rx, rh);
  ctx.fillStyle = face;
  ctx.fill();

  // One offset specular, the way a mylar head catches a room light.
  const spec = ctx.createRadialGradient(
    cx - rx * 0.34,
    cy - rh * 0.42,
    0,
    cx - rx * 0.34,
    cy - rh * 0.42,
    rx * 0.62,
  );
  spec.addColorStop(0, "rgba(255,255,255,0.55)");
  spec.addColorStop(1, "rgba(255,255,255,0)");
  ctx.save();
  ellipsePath(ctx, cx, cy, rx, rh);
  ctx.clip();
  ctx.fillStyle = spec;
  ctx.fillRect(cx - rx, cy - rh, rx * 2, rh * 2);
  ctx.restore();

  // Hairline of shadow where the head tucks under the hoop.
  ellipsePath(ctx, cx, cy, rx * 0.985, rh * 0.985);
  ctx.strokeStyle = "rgba(0, 0, 0, 0.28)";
  ctx.lineWidth = Math.max(1, rx * 0.02);
  ctx.stroke();

  // Hoop, straddling the head/shell seam.
  const hoop = ctx.createLinearGradient(cx - rx, cy - ry, cx + rx, cy + ry);
  hoop.addColorStop(0, "#f4f7fb");
  hoop.addColorStop(0.45, look.metal);
  hoop.addColorStop(1, "#59616e");
  ellipsePath(ctx, cx, cy, rx, ry);
  ctx.strokeStyle = hoop;
  ctx.lineWidth = Math.max(2, rx * 0.055);
  ctx.stroke();

  // Impact ripple, from where the stick actually landed.
  if (amp > 0 && prog < 1) {
    const px = strike ? strike[0] : cx;
    const py = strike ? strike[1] : cy;
    const rr = rx * (0.1 + 1.0 * prog);
    ctx.save();
    ellipsePath(ctx, cx, cy, rx * 0.96, rh * 0.96);
    ctx.clip();
    ctx.beginPath();
    ctx.ellipse(px, py, rr, rr * (ry / rx), 0, 0, Math.PI * 2);
    ctx.strokeStyle = look.glow;
    ctx.globalAlpha = amp * (1 - prog) * 0.9;
    ctx.lineWidth = Math.max(1.5, rx * 0.05 * (1 - prog));
    ctx.stroke();
    ctx.restore();
  }
}

/** A bass drum: front head rising out of the bottom of the frame, the way it
 * looks from behind the kit. Sized from the STAGE floor rather than the zone,
 * because the zone is a short wide strip and a circle inscribed in its width
 * would tower over the snare. */
function drawFrontDrum(
  ctx: CanvasRenderingContext2D,
  r: [number, number, number, number],
  st: Stage,
  look: Look,
  amp: number,
  prog: number,
): void {
  const [x, , w] = r;
  const cx = x + w / 2;
  const rad = (w * look.fit) / 2;
  // Push the centre below the floor so only the top cap is visible.
  const cy = st.y + st.h + rad * 0.34;

  radialGlow(ctx, cx, cy - rad * 0.5, rad * 1.6, look.glow, amp * (1 - prog) * 0.55);

  const shell = ctx.createLinearGradient(cx - rad, 0, cx + rad, 0);
  shell.addColorStop(0, look.body[0]);
  shell.addColorStop(0.36, look.body[1]);
  shell.addColorStop(1, look.body[2]);
  ctx.beginPath();
  ctx.arc(cx, cy, rad, Math.PI, 0);
  ctx.closePath();
  ctx.fillStyle = shell;
  ctx.fill();

  const push = 1 - 0.06 * amp * Math.max(0, 1 - prog * 2.2);
  const head = ctx.createRadialGradient(
    cx - rad * 0.28,
    cy - rad * 0.55,
    rad * 0.04,
    cx,
    cy,
    rad,
  );
  head.addColorStop(0, "#fdf6e9");
  head.addColorStop(0.5, look.face);
  head.addColorStop(1, look.faceLow);
  ctx.beginPath();
  ctx.arc(cx, cy, rad * 0.88 * push, Math.PI, 0);
  ctx.closePath();
  ctx.fillStyle = head;
  ctx.fill();

  // Port hole. Placed high in the cap: this drum's centre is below the floor
  // line, so anything near it would never be on screen.
  ctx.beginPath();
  ctx.ellipse(cx + rad * 0.3, cy - rad * 0.5, rad * 0.15, rad * 0.19, 0, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(8, 6, 10, 0.82)";
  ctx.fill();
  ctx.strokeStyle = "rgba(255, 255, 255, 0.18)";
  ctx.lineWidth = Math.max(1, rad * 0.012);
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(cx, cy, rad, Math.PI, 0);
  ctx.strokeStyle = look.metal;
  ctx.lineWidth = Math.max(2, rad * 0.045);
  ctx.stroke();

  if (amp > 0 && prog < 1) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, rad * (0.15 + 0.8 * prog), Math.PI, 0);
    ctx.strokeStyle = look.glow;
    ctx.globalAlpha = amp * (1 - prog) * 0.85;
    ctx.lineWidth = Math.max(1.5, rad * 0.04 * (1 - prog));
    ctx.stroke();
    ctx.restore();
  }
}

/** One bronze disc. `tilt` is the wobble angle in radians. */
function cymbalDisc(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  tilt: number,
  look: Look,
  flash: number,
): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(tilt);

  const g = ctx.createLinearGradient(-rx, -ry, rx, ry);
  g.addColorStop(0, look.body[0]);
  g.addColorStop(0.35, look.body[1]);
  g.addColorStop(0.62, look.face);
  g.addColorStop(1, look.body[2]);
  ellipsePath(ctx, 0, 0, rx, ry);
  ctx.fillStyle = g;
  ctx.fill();

  // Lathing grooves: the thing that makes bronze read as bronze.
  ctx.strokeStyle = "rgba(60, 40, 8, 0.3)";
  ctx.lineWidth = Math.max(0.6, rx * 0.007);
  for (let i = 1; i <= 9; i++) {
    const k = i / 10;
    ellipsePath(ctx, 0, 0, rx * k, ry * k);
    ctx.stroke();
  }

  // Bell.
  const bell = ctx.createRadialGradient(-rx * 0.06, -ry * 0.4, 0, 0, 0, rx * 0.22);
  bell.addColorStop(0, "#fffbe8");
  bell.addColorStop(1, look.metal);
  ellipsePath(ctx, 0, -ry * 0.14, rx * 0.17, ry * 0.4);
  ctx.fillStyle = bell;
  ctx.fill();

  // Edge.
  ellipsePath(ctx, 0, 0, rx, ry);
  ctx.strokeStyle = look.metal;
  ctx.lineWidth = Math.max(1, rx * 0.018);
  ctx.stroke();

  if (flash > 0.002) {
    ellipsePath(ctx, 0, 0, rx, ry);
    ctx.fillStyle = look.glow;
    ctx.globalAlpha = flash * 0.45;
    ctx.fill();
  }
  ctx.restore();
}

function drawCymbal(
  ctx: CanvasRenderingContext2D,
  r: [number, number, number, number],
  st: Stage,
  look: Look,
  amp: number,
  prog: number,
): void {
  const [x, y, w, h] = r;
  const cx = x + w / 2;
  const rx = (w * look.fit) / 2;
  const ry = rx * 0.19;
  const cy = y + h * 0.44;

  // Damped wobble: real cymbals ring visibly, and how fast it dies is the
  // clearest cue for how hard the strike was.
  const t = prog * (HIT_MS / 1000);
  const tilt = look.tilt + amp * 0.15 * Math.exp(-t / 0.16) * Math.sin(2 * Math.PI * 7.5 * t);

  standTo(ctx, cx, cy, st.y + st.h, Math.max(2, rx * 0.03));
  radialGlow(ctx, cx, cy, rx * 1.9, look.glow, amp * (1 - prog) * 0.45);
  cymbalDisc(ctx, cx, cy, rx, ry, tilt, look, amp * (1 - prog));

  if (amp > 0 && prog < 1) {
    ctx.save();
    ctx.globalAlpha = amp * (1 - prog) * 0.5;
    ctx.strokeStyle = look.glow;
    for (const off of [0, 0.22]) {
      const pr = prog + off;
      if (pr >= 1) continue;
      const k = 1 + 0.5 * pr;
      ellipsePath(ctx, cx, cy, rx * k, ry * k);
      ctx.lineWidth = Math.max(1, rx * 0.028 * (1 - pr));
      ctx.stroke();
    }
    ctx.restore();
  }
}

function drawHiHat(
  ctx: CanvasRenderingContext2D,
  r: [number, number, number, number],
  st: Stage,
  look: Look,
  amp: number,
  prog: number,
): void {
  const [x, y, w, h] = r;
  const cx = x + w / 2;
  const rx = (w * look.fit) / 2;
  const ry = rx * 0.17;
  const cy = y + h * 0.52;

  // The pair slams shut on impact and springs back: that snap is the whole
  // visual identity of a hi-hat.
  const openRest = ry * 1.5;
  const gap = openRest * (1 - 0.85 * amp * Math.exp(-prog * 5));
  const t = prog * (HIT_MS / 1000);
  const tilt = amp * 0.09 * Math.exp(-t / 0.1) * Math.sin(2 * Math.PI * 11 * t);

  standTo(ctx, cx, cy - openRest, st.y + st.h, Math.max(2, rx * 0.035));
  radialGlow(ctx, cx, cy, rx * 1.8, look.glow, amp * (1 - prog) * 0.45);

  cymbalDisc(ctx, cx, cy, rx, ry, 0, look, 0); // bottom, fixed
  cymbalDisc(ctx, cx, cy - gap, rx, ry, tilt, look, amp * (1 - prog)); // top

  // Pull rod through the middle.
  ctx.fillStyle = "rgba(150, 160, 176, 0.7)";
  ctx.fillRect(cx - 1.5, cy - openRest - ry * 1.5, 3, openRest + ry * 1.5);
}

// ---------------------------------------------------------------------------
// Sticks
// ---------------------------------------------------------------------------

/** A drumstick held the way a drummer holds one.
 *
 * The BEAD sits on the tracked landmark, because that point is where the hit
 * actually registers: drawing it anywhere else would be a lie about the
 * instrument. Everything else hangs off that constraint. The shaft therefore
 * runs UP and OUTWARD from the bead to the butt, with the gripping hand near
 * the butt, which is the real geometry of a stroke: hand above, bead on the
 * head. Drawing it the other way round (butt below the bead) reads as a stick
 * dangling from the fingertips and is the single thing that made the old kit
 * look fake.
 */
export interface StickGeom {
  /** The tracked point. This is the BUTT of the stick, because that is the end
   * a hand actually grips, and it is also where the hit registers. */
  handX: number;
  handY: number;
  /** The bead, up and outward from the hand. */
  tipX: number;
  tipY: number;
  /** Where the fingers wrap, just above the butt. */
  gripX: number;
  gripY: number;
}

/** Stick geometry, separated from the painting so it can be asserted.
 *
 * Two invariants, both of which were wrong in earlier versions and neither of
 * which any test caught until it was written down:
 *
 *   tipY < handY        the stick rises from the hand, it does not dangle.
 *   thick end at hand   you grip a drumstick by its BUTT. Putting the bead in
 *                       the hand leaves the fat end waving in the air, which
 *                       reads as a stick held upside down, because it is.
 */
export function stickGeometry(
  tx: number,
  ty: number,
  st: Stage,
  hand: string,
): StickGeom {
  // "L" is the player's left hand and, in the mirrored view, appears on the
  // left of the screen, so its tip leans up-LEFT, away from the body centre.
  // Negating this is invisible until you watch someone play and both sticks
  // cross their chest.
  const dir = hand === "L" ? -1 : 1;
  const len = st.h * 0.24;
  const tipX = tx + dir * len * 0.42;
  const tipY = ty - len * 0.9;
  return {
    handX: tx,
    handY: ty,
    tipX,
    tipY,
    gripX: tx + (tipX - tx) * 0.18,
    gripY: ty + (tipY - ty) * 0.18,
  };
}

function drawStick(
  ctx: CanvasRenderingContext2D,
  tx: number,
  ty: number,
  st: Stage,
  hand: string,
  conf: number,
): void {
  const { tipX, tipY } = stickGeometry(tx, ty, st, hand);
  const dx = tipX - tx;
  const dy = tipY - ty;
  const len = Math.hypot(dx, dy) || 1;
  const ax = dx / len; // along the shaft, hand -> tip
  const ay = dy / len;
  const ux = -ay; // across it
  const uy = ax;

  // A 5A stick is about 29:1 long-to-thick. An earlier version was 13.6:1,
  // which is a wooden spoon, and no amount of shading rescues the wrong
  // silhouette.
  const wShaft = Math.max(2.4, len / 29);
  const wButt = wShaft * 1.1;
  const wNeck = wShaft * 0.6;
  const rBead = wShaft * 1.6;
  const tone = hand === "L" ? "#38bdf8" : "#f87171";

  /** A point `s` along the axis from the hand, offset `w` across it. */
  const at = (s: number, w: number): [number, number] => [
    tx + ax * s + ux * w,
    ty + ay * s + uy * w,
  ];
  // Real sticks are near-constant for most of their length and taper only over
  // the last third. A straight wedge butt-to-tip reads as a ramp, not a stick.
  const sShoulder = len * 0.62;
  const sNeck = len * 0.88;

  ctx.save();
  ctx.globalAlpha = Math.max(0.4, Math.min(1, conf));

  // Contact shadow under the hand: without it the stick floats and you cannot
  // judge how close to the head it is.
  ctx.save();
  ctx.globalAlpha *= 0.3;
  ctx.beginPath();
  ctx.ellipse(tx, ty + wButt * 2.2, wButt * 3, wButt * 1.2, 0, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(0, 0, 0, 0.9)";
  ctx.fill();
  ctx.restore();

  // Silhouette: rounded butt at the hand, straight shaft, neck, then the bead.
  ctx.beginPath();
  ctx.moveTo(...at(0, wButt));
  ctx.lineTo(...at(sShoulder, wShaft));
  ctx.quadraticCurveTo(...at(sNeck * 0.97, wShaft * 0.82), ...at(sNeck, wNeck));
  ctx.lineTo(...at(sNeck, -wNeck));
  ctx.quadraticCurveTo(...at(sNeck * 0.97, -wShaft * 0.82), ...at(sShoulder, -wShaft));
  ctx.lineTo(...at(0, -wButt));
  ctx.quadraticCurveTo(...at(-wButt * 1.3, 0), ...at(0, wButt));
  ctx.closePath();

  // Shade ACROSS the shaft, not along it. This is the whole difference between
  // a cylinder and a painted plank: the eye reads roundness from a highlight
  // running parallel to the long axis with both edges falling into shadow.
  const mid = at(len * 0.5, 0);
  const barrel = ctx.createLinearGradient(
    mid[0] - ux * wShaft,
    mid[1] - uy * wShaft,
    mid[0] + ux * wShaft,
    mid[1] + uy * wShaft,
  );
  barrel.addColorStop(0, "#5c3a1c");
  barrel.addColorStop(0.32, "#e8c48d");
  barrel.addColorStop(0.5, "#d2a367");
  barrel.addColorStop(1, "#6b431f");
  ctx.fillStyle = barrel;
  ctx.fill();
  ctx.strokeStyle = "rgba(28, 18, 8, 0.55)";
  ctx.lineWidth = 1;
  ctx.stroke();

  // Grip tape where the fingers wrap. This replaces a translucent blob that
  // was drawn ON TOP of the player's real hand, already visible in the camera
  // image: a second, fake hand there reads as a rendering fault. A wrap is
  // what a drummer really has, and it carries the L/R colour.
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(...at(len * 0.08, wShaft * 1.12));
  ctx.lineTo(...at(len * 0.32, wShaft * 1.08));
  ctx.lineTo(...at(len * 0.32, -wShaft * 1.08));
  ctx.lineTo(...at(len * 0.08, -wShaft * 1.12));
  ctx.closePath();
  const tape = ctx.createLinearGradient(
    mid[0] - ux * wShaft,
    mid[1] - uy * wShaft,
    mid[0] + ux * wShaft,
    mid[1] + uy * wShaft,
  );
  tape.addColorStop(0, "rgba(6, 12, 20, 0.9)");
  tape.addColorStop(0.34, tone);
  tape.addColorStop(1, "rgba(6, 12, 20, 0.92)");
  ctx.fillStyle = tape;
  ctx.fill();
  ctx.restore();

  // Bead: a wooden ellipsoid on the axis with its own highlight. An earlier
  // flat white disc with a coloured ring read as a UI dot stuck on the end.
  const bead = at(len - rBead * 0.5, 0);
  const bg = ctx.createRadialGradient(
    bead[0] - ux * rBead * 0.4,
    bead[1] - uy * rBead * 0.4,
    rBead * 0.1,
    bead[0],
    bead[1],
    rBead * 1.4,
  );
  bg.addColorStop(0, "#fff6e4");
  bg.addColorStop(0.4, "#e0b478");
  bg.addColorStop(1, "#8a5a2a");
  ctx.beginPath();
  ctx.ellipse(bead[0], bead[1], rBead * 1.15, rBead, Math.atan2(ay, ax), 0, Math.PI * 2);
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.strokeStyle = "rgba(28, 18, 8, 0.5)";
  ctx.lineWidth = 1;
  ctx.stroke();

  // A restrained glow at the HAND, which is where the hit actually registers.
  radialGlow(ctx, tx, ty, wButt * 5, tone, 0.3);
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Backdrop
// ---------------------------------------------------------------------------

function drawBackdrop(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  st: Stage,
  video: HTMLVideoElement | null,
): void {
  const room = ctx.createRadialGradient(
    canvas.width / 2,
    canvas.height * 0.34,
    0,
    canvas.width / 2,
    canvas.height * 0.34,
    Math.max(canvas.width, canvas.height) * 0.75,
  );
  room.addColorStop(0, "#161c2b");
  room.addColorStop(1, "#05070d");
  ctx.fillStyle = room;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Camera image, mirrored and graded down so the kit reads on top of it.
  if (video && video.readyState >= 2) {
    ctx.save();
    ctx.translate(st.x + st.w, st.y);
    ctx.scale(-1, 1);
    ctx.globalAlpha = 0.62;
    ctx.drawImage(video, 0, 0, st.w, st.h);
    ctx.restore();
  }

  // Floor wash under the kit, then a vignette to pull the eye to the centre.
  const floor = ctx.createLinearGradient(0, st.y + st.h * 0.55, 0, st.y + st.h);
  floor.addColorStop(0, "rgba(5, 7, 13, 0)");
  floor.addColorStop(1, "rgba(5, 7, 13, 0.72)");
  ctx.fillStyle = floor;
  ctx.fillRect(st.x, st.y + st.h * 0.55, st.w, st.h * 0.45);

  const vig = ctx.createRadialGradient(
    st.x + st.w / 2,
    st.y + st.h / 2,
    st.h * 0.25,
    st.x + st.w / 2,
    st.y + st.h / 2,
    st.h * 0.92,
  );
  vig.addColorStop(0, "rgba(0,0,0,0)");
  vig.addColorStop(1, "rgba(0,0,0,0.62)");
  ctx.fillStyle = vig;
  ctx.fillRect(st.x, st.y, st.w, st.h);

  // Letterbox bars stay pure stage colour, and a hairline marks the frame so
  // it is obvious what the camera can actually see.
  ctx.strokeStyle = "rgba(148, 163, 184, 0.18)";
  ctx.lineWidth = 2;
  ctx.strokeRect(st.x + 1, st.y + 1, st.w - 2, st.h - 2);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function draw(state: UiState, canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const st = stageOf(canvas, state.aspect);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawBackdrop(ctx, canvas, st, state.video);

  // Newest strike per zone drives that zone's animation.
  const fx = new Map<string, HitFx>();
  for (const h of state.hits) {
    if (h.zone === null) continue;
    const age = state.nowMs - h.t_ms;
    if (age < 0 || age > HIT_MS) continue;
    const prev = fx.get(h.zone);
    if (!prev || h.t_ms > prev.t_ms) fx.set(h.zone, h);
  }

  // Painter's algorithm: the pieces at the back of the kit are the high ones.
  const ordered = [...state.zones.zones].sort((a, b) => a.y0 - b.y0);

  for (const z of ordered) {
    const look = LOOKS[z.id] ?? FALLBACK;
    const r = rectOf(st, z);
    const hit = fx.get(z.id);
    const prog = hit ? (state.nowMs - hit.t_ms) / HIT_MS : 1;
    // Velocity is already normalized 0..1 by the detector (PLAN 5.2); floor it
    // so a ghost note still shows something.
    const amp = hit ? 0.35 + 0.65 * Math.min(1, Math.max(0, hit.velocity)) : 0;
    const strike: [number, number] | null = hit
      ? [sx(st, hit.x), sy(st, hit.y)]
      : null;

    if (look.piece === "cymbal") drawCymbal(ctx, r, st, look, amp, prog);
    else if (look.piece === "hihat") drawHiHat(ctx, r, st, look, amp, prog);
    else if (look.piece === "front") drawFrontDrum(ctx, r, st, look, amp, prog);
    else drawDrum(ctx, r, st, look, amp, prog, strike);
  }

  // Beat flash on the frame edge: peripheral, so it never competes with the
  // kit for attention but is still impossible to miss.
  if (state.lastBeatMs !== null) {
    const age = state.nowMs - state.lastBeatMs;
    if (age >= 0 && age < BEAT_MS) {
      ctx.save();
      ctx.globalAlpha = (1 - age / BEAT_MS) * 0.55;
      ctx.strokeStyle = "#fbbf24";
      ctx.lineWidth = Math.max(4, st.h * 0.012);
      ctx.strokeRect(st.x + 2, st.y + 2, st.w - 4, st.h - 4);
      ctx.restore();
    }
  }

  for (const hd of state.hands) {
    drawStick(ctx, sx(st, hd.x), sy(st, hd.y), st, hd.hand, hd.conf);
  }

  // Calibration view: the TRUE trigger rectangles, which are deliberately a
  // little larger than the pieces drawn inside them.
  if (state.showZones) {
    ctx.save();
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = "rgba(125, 211, 252, 0.75)";
    ctx.fillStyle = "rgba(125, 211, 252, 0.9)";
    ctx.lineWidth = 1.5;
    ctx.font = `${Math.max(11, st.h / 46)}px ui-monospace, monospace`;
    for (const z of state.zones.zones) {
      const [x, y, w, h] = rectOf(st, z);
      ctx.strokeRect(x, y, w, h);
      ctx.fillText(z.id, x + 6, y + Math.max(14, st.h / 42));
    }
    ctx.restore();
  }
}
