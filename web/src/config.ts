/** Tuning constants (PLAN 4).
 *
 * `config/default.json` is the single source of truth, read by BOTH the
 * Python and the TS implementations. Neither side may hardcode these values;
 * tuning them in one place updates both, which is what stops the two
 * detectors drifting apart after the first tuning pass.
 */

export interface FilterCfg {
  min_cutoff: number;
  beta: number;
  d_cutoff: number;
}

export interface DetectCfg {
  v_min: number;
  v_max: number;
  decel_ratio: number;
  refrac_ms: number;
  offset_ms: number;
  min_conf: number;
  match_window_ms: number;
}

export interface HandCfg {
  track_landmark: number;
  palm_a: number;
  palm_b: number;
  num_hands: number;
}

export interface Config {
  filter: FilterCfg;
  detection: DetectCfg;
  hand: HandCfg;
}

/** Mirror of `Config.from_dict` (py/vdrum/config.py). */
export function configFromDict(raw: {
  filter: FilterCfg;
  detection: DetectCfg;
  hand: HandCfg;
}): Config {
  return {
    filter: { ...raw.filter },
    detection: { ...raw.detection },
    hand: { ...raw.hand },
  };
}

/** Mirror of `Config.with_filter` (per-case overrides in the fixtures). */
export function withFilter(cfg: Config, overrides: Partial<FilterCfg>): Config {
  return { ...cfg, filter: { ...cfg.filter, ...overrides } };
}
