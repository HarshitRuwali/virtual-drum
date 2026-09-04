/** The audio/performance clock bridge (PLAN 3.1).
 *
 * `AudioContext.currentTime` and `performance.now()` are different clocks with
 * different origins and, on some platforms, measurably different rates. Every
 * timestamp this app reports is compared against a metronome click, so mixing
 * the two silently poisons the one number the tool exists to produce.
 *
 * `getOutputTimestamp()` is the only sanctioned way to relate them: it returns
 * a matched pair sampled at the same instant. Anything derived from an audio
 * clock must come through here.
 */

/** A matched (contextTime, performanceTime) pair, or null when the platform
 * does not implement getOutputTimestamp or has not started the clock yet. */
export function bridge(
  ctx: AudioContext,
): { contextTime: number; performanceTime: number } | null {
  const ots = ctx.getOutputTimestamp?.();
  const c = ots?.contextTime;
  const p = ots?.performanceTime;
  if (c === undefined || p === undefined || c <= 0 || p <= 0) return null;
  return { contextTime: c, performanceTime: p };
}

/** Convert an AudioContext instant to the performance clock.
 *
 * Falls back to "now minus how long ago it was", which is correct to within
 * the drift between the two clocks over one callback: worse than the bridge,
 * far better than pretending the two origins coincide. */
export function audioToPerf(ctx: AudioContext, contextTime: number): number {
  const b = bridge(ctx);
  if (b) return b.performanceTime + (contextTime - b.contextTime) * 1000;
  return performance.now() - (ctx.currentTime - contextTime) * 1000;
}
