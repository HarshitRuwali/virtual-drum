export interface StompOpts {
  threshold?: number;
  floor?: number;
  cutoffHz?: number;
  refractoryMs?: number;
  lowFrac?: number;
  fastMs?: number;
  slowMs?: number;
}
export const DEFAULTS: Required<StompOpts>;
export class StompDetector {
  constructor(sampleRate: number, opts?: StompOpts);
  sampleRate: number;
  /** low-band peak envelope */
  fast: number;
  /** full-band peak envelope */
  wide: number;
  mute(ms: number): void;
  process(block: Float32Array | number[]): { offset: number; velocity: number } | null;
}
