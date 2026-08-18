/** Zone model (PLAN 6.1). TS port of `py/vdrum/zones.py`.
 *
 * Zones are axis-aligned rectangles in aspect-corrected normalized space
 * (X = x * W/H, Y = y), optionally banded by `scale` (palm width) as the depth
 * proxy. Coordinates are UN-mirrored (raw) image space; mirroring happens only
 * at render time (PLAN 3.5).
 */

export interface Zone {
  id: string;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  scale_min: number;
  scale_max: number;
  sample: string | null;
}

export interface ZoneDict {
  id: string;
  x: [number, number];
  y: [number, number];
  scale?: [number, number];
  sample?: string | null;
}

export interface ZoneSetDict {
  zones: ZoneDict[];
}

export function contains(z: Zone, x: number, y: number, scale: number): boolean {
  return (
    z.x0 <= x &&
    x <= z.x1 &&
    z.y0 <= y &&
    y <= z.y1 &&
    z.scale_min <= scale &&
    scale <= z.scale_max
  );
}

export class ZoneSet {
  zones: Zone[];

  constructor(zones: Zone[]) {
    this.zones = zones;
  }

  /** Mirror of `ZoneSet.load` (py/vdrum/zones.py) over the JSON shape. */
  static fromDict(raw: ZoneSetDict): ZoneSet {
    const zones: Zone[] = [];
    for (const z of raw.zones) {
      const sc = z.scale ?? [0.0, 1.0];
      zones.push({
        id: z.id,
        x0: z.x[0],
        x1: z.x[1],
        y0: z.y[0],
        y1: z.y[1],
        scale_min: sc[0],
        scale_max: sc[1],
        sample: z.sample ?? null,
      });
    }
    return new ZoneSet(zones);
  }

  /** First match in list order wins (py zones.lookup). */
  lookup(x: number, y: number, scale: number): Zone | null {
    for (const z of this.zones) {
      if (contains(z, x, y, scale)) return z;
    }
    return null;
  }
}
