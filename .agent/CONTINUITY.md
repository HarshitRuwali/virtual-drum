# CONTINUITY — virtual-drum

Canonical briefing. Read before acting. Full plan: `../PLAN.md`.

## [PLANS]
- 2026-08-18T07:23Z [USER] Webcam air-drum practice tool: Python detection prototype →
  browser app. Hands-first tracking, stick markers deferred. Kit + metronome + per-hit
  timing error (ms). Excludes lesson/play-along tracks.
- 2026-08-18T08:56Z [ASSUMPTION] Phases 0–6 per PLAN.md §10. Phase 0 (fixture capture,
  needs laptop camera) gates everything downstream.
- 2026-08-18T12:04Z [TOOL] Phase 1 (headless core) done: py/vdrum complete, 34 tests
  green in python:3.14-slim, 12 parity fixtures in web/test/fixtures/.
- 2026-08-18T12:45Z [TOOL] Phase 3 done: TS port in web/src (config/filter/zones/
  detect/score) + parity gate GREEN — 13/13 fixtures bit-identical (vitest `toBe`),
  19 tests total, tsc clean, `vite build` OK, dev server serves all assets
  (model 7819105B verified). Phases 4–6 (audio/metronome/UI) code-complete in
  web/src; live camera/GPU/audio verification still needs a laptop (PLAN §1).

## [DECISIONS]
- 2026-08-18T07:23Z [USER] Python prototype first, then port to browser.
- 2026-08-18T07:23Z [USER] Bare-hand landmarks now; marker tracker later behind the same
  `Tracker` interface.
- 2026-08-18T08:56Z [ASSUMPTION] Track landmark 9 (MIDDLE_FINGER_MCP): stabler than
  fingertips, leads the wrist, approximates a stick fulcrum.
- 2026-08-18T08:56Z [ASSUMPTION] Fire hits on velocity peak (not vy zero-crossing) —
  the 20–40ms peak→strike lead is the budget that pays for inference + audio latency.
  Audio plays at detection; the *reported* timestamp is offset to the true strike.
- 2026-08-18T08:56Z [ASSUMPTION] Normalize velocity by palm width ‖p5−p17‖ so thresholds
  are distance-invariant. Rigid span; unlike wrist→MCP it ignores wrist flex.
- 2026-08-18T08:56Z [ASSUMPTION] `config/default.json` shared by Python and TS so tuned
  constants cannot drift between implementations.
- 2026-08-18T08:56Z [ASSUMPTION] Kick via keyboard binding in v1 — no foot in frame, and
  a faked hand-kick would corrupt the timing data the tool exists to measure.
- 2026-08-18T12:04Z [CODE] REFRACTORY re-arms only when `t - fire_t > REFRAC_MS` AND
  `vy_n < V_MIN` (settle test, not time-only): the One Euro tail keeps "descending"
  hundreds of ms after the strike and a time-only rule re-arms into a ghost second hit
  (~180 ms later). A real re-strike rebounds first, which settles velocity.
- 2026-08-18T12:04Z [CODE] A stroke in progress when tracking is lost (hand exits frame /
  low conf) is COMMITTED at its observed peak (`HandState.commit_if_pending`): the decel
  confirmation never arrives for a hand that leaves right after the strike, so without
  this the most common real stroke (hit → hand exits) is lost.
- 2026-08-18T12:04Z [CODE] GAP_MS reset also resets the One Euro filter memory
  (`OneEuro.reset()`): the filter's residual across the gap reads as a phantom stroke
  (measured 3.16 vy_n ghost after a 0.05-unit jump) and re-triggers DESCENDING.
- 2026-08-18T13:05Z [CODE] `score()` TS port aligned to the PYTHON reference
  (not the other way round): flat time lists (zones grouped at the CALL SITE,
  like py/vdrum/sweep.py), population stddev for jitter, 0.0 defaults, no
  zone matching inside score(). `fitOffset()` is app-layer only (PLAN 8.4),
  and it shifts the READOUT, never the stored history (avoids a circular
  fit). Verified: 8/8 cases bit-identical Python↔TS via direct cross-check.
- 2026-08-18T12:45Z [CODE] The live app's `StreamingDetector` IS the `detect()`
  loop body (same `HandState`, same tracked-test, same step/commitIfPending
  order) — the browser path cannot drift from the parity-tested path by
  construction. Absent hands get `commitAbsent()` (the untracked-frame
  else-branch).
- 2026-08-18T12:04Z [CODE] Hit list sorted by total key `(report_t_ms, hand)`:
  simultaneous hits tie on report time, and stable-sort order then depends on channel
  dict order, which differs between the original track and the JSON round-trip
  (hands list is sorted) — the TS parity gate needs one canonical order.

## [DISCOVERIES]
- 2026-08-18T07:23Z [TOOL] `ubuntu-dev` has no camera, no display, no audio sink
  (`/dev/video*` absent, no USB cam, `DISPLAY` unset, `/dev/snd` = `seq`+`timer` only).
  Consequence: Python side is headless + fixture-driven; all live/audio work is browser
  on the laptop.
- 2026-08-18T08:56Z [TOOL] `mediapipe==1.0.1` installs and imports on Python 3.14.4 here.
  An initial worry that 3.14 was too new was wrong.
- 2026-08-18T08:56Z [TOOL] `@mediapipe/tasks-vision@1.0.1` (published 2026-08-17) is the
  same generation as the Python package — same model, same 21-landmark topology, same
  VIDEO-mode explicit-timestamp API. Port is algorithm-only; the mechanical surface is
  field casing (`hand_landmarks`→`landmarks`, `hand_world_landmarks`→`worldLandmarks`).
  Both default `num_hands`/`numHands` to **1** — must set 2.
- 2026-08-18T08:56Z [TOOL] JS package bundles its own wasm under `wasm/`, so
  `FilesetResolver.forVisionTasks()` can use a local path — no CDN, works offline.
- 2026-08-18T08:56Z [TOOL] Model asset `hand_landmarker.task` float16 = 7,819,105 B,
  HTTP 200 at both `/latest/` and `/1/` (identical size). Pin `/1/`.
- 2026-08-18T09:20Z [TOOL] **Container recipe, verified end to end.** mediapipe 1.0.1
  `dlopen`s a GL chain lazily inside `create_from_options()`, surfacing one missing lib
  at a time: `libxcb.so.1` (fix: `opencv-contrib-python-headless` instead of the GUI
  build mediapipe pulls) → `libEGL.so.1` (`libegl1`) → `libGLESv2.so.2` (`libgles2`).
  Final apt set: `libegl1 libgles2 libgl1 libglib2.0-0`. Image 1.13GB, smoke test prints
  `create_from_options OK` and processes 600 frames. **`import mediapipe` succeeding
  proves nothing** — an import-only smoke test passes at all three broken stages, so
  `docker/smoke.py` calls `create_from_options()`.
- 2026-08-18T08:56Z [ASSUMPTION] Optimize tuning for F1 + stddev(Δt), never mean(Δt):
  bias is a calibration constant to subtract, jitter is irreducible pipeline quality.
- 2026-08-18T09:20Z [TOOL] Measured in-container CPU throughput: 14.66 ms/frame
  inference, 1.0x realtime on 640x480@60fps — and that is the FLOOR (empty frame, palm
  detector only, no GPU delegate). Two tracked hands will be worse.
  Consequence [ASSUMPTION]: pipeline must split into `extract.py` (video → cached
  `tracks/*.npz`, once per fixture) and `detect.py` (track → hits, pure numpy, swept
  thousands of times). Otherwise a Phase 2 parameter sweep costs minutes of inference per
  combination and cannot be run.    `detect.py` must never own a VideoCapture.
- 2026-08-18T12:04Z [TOOL] One Euro tail, measured: after a 15.7 palm-widths/s stroke,
  the filtered velocity stays above `0.6*peak` for ~6+ frames (≥100 ms) and above
  V_MIN for far longer — the filter's position residual catches up while the input is
  already flat. Any fire-on-decel design must (a) confirm on decel (not fire at peak)
  and (b) not let that tail re-arm (settle test). Also: with 7-decimal test literals,
  the *first* post-reset velocity is penalized by the EMA one-step lag, so an
  "equal-velocity" profile peaks on frame 2, not frame 1 — tests must not assert an
  exact peak frame on equal-velocity inputs (float coin-flip at ~1e-6).
- 2026-08-18T13:40Z [TOOL] **Code review of the completed codebase.** 12 findings;
  all gates still pass (54 tests, typecheck clean), so none are caught by CI.
  Highest severity, both VERIFIED by execution:
  1. `extract.py:40-72` — a hand first detected after frame 0 never gets backfilled
     for the earlier frames, so its channel arrays are SHORTER than `t_ms`.
     `detect.py:281` then indexes out of range. Reproduced: `IndexError: index 3 is
     out of bounds for axis 0 with size 3`. The entire real-video path crashes the
     first time a hand enters the frame late — which is the normal case. Invisible
     to CI because every fixture is synthetic and full-length.
  2. PLAN 3.1 (frame clock) NOT implemented on the web side: `requestVideoFrameCallback`
     0 uses, `getOutputTimestamp` 0 uses, `latencyHint`/`baseLatency`/`outputLatency`
     0 uses. `main.ts:151` and `tracker.ts:77` use `performance.now()` in a rAF
     callback — the exact anti-pattern PLAN 3.1 was written to forbid. Adds ~1 refresh
     interval of jitter to the readout, and jitter is the non-calibratable metric.
     `metronome.ts:25` samples the audio/perf clock bridge ONCE in the constructor
     instead of via `getOutputTimestamp()`, so drift accumulates over a session.
  3. `detect.py:234-236` and `detect.ts:140-142` are UNREACHABLE for any
     `decel_ratio >= 0.5` (needs `peak < v_min*0.5/decel_ratio = 0.667` while
     DESCENDING requires `peak > v_min = 0.8`). The documented "fade-out cancels"
     rejection never happens. Faithfully ported to TS, so the parity gate passes with
     both sides wrong — a structural blind spot: parity proves agreement, not correctness.
  4. Timing feedback is snare-only: `expectedByZone` is written solely with "snare"
     (`main.ts:108`); all other zones return early. Undocumented.
- 2026-08-18T13:40Z [DISCOVERY] A predicted severe bug did NOT reproduce: rAF at 60Hz
  over a 30fps camera re-steps the state machine on duplicate frames, which I expected
  to cause premature firing. Tested both sampling patterns: same hit count, same
  `peak_t=466.7ms`. The One Euro filter keeps `yf` converging on repeated samples so
  `vy_n` never collapses to 0. Only peak velocity inflates (0.951 -> clipped 1.0),
  shifting the loudness mapping. Recorded so nobody "fixes" this twice.

## [PROGRESS]
- 2026-08-18T12:04Z [TOOL] Python core + tests complete. py/vdrum: config, filter,
  zones, detect (state machine + OneEuro + gap guard + commit-on-loss), score, tracker,
  extract, pipeline, sweep, testgen, cli. py/tests: 34 passed in python:3.14-slim
  (filter/detect/score/zones/parity). 12 parity fixtures written to web/test/fixtures/
  via `write_fixtures()` — the exact JSON surface the TS gate consumes.
- 2026-08-18T09:20Z [TOOL] Planning + verification. `docker/Dockerfile` and
  `docker/smoke.py` written and verified working.
- 2026-08-18T08:56Z [TOOL] PLAN.md expanded to full detail (§1–11:
  constraints, verified deps, the two hard problems, architecture, algorithm with
  pseudocode + starting constants, zones/audio, verification + parity gate, calibration
  maths, container recipe, phases, risks). No code, no container image committed,
  no fixtures.

## [OUTCOMES]
- 2026-08-18T13:05Z [TOOL] Phase 3 milestone: two independent implementations
  (Python + TS) agree bit-for-bit — 12/12 detect fixtures (parity gate, PLAN
  7.2) and 8/8 score() cases (direct cross-check). Full gate GREEN: 34 Python
  tests (container) + 20 TS tests + tsc + vite build + dev-server asset check
  (model 7819105B). Web app shell (tracker/audio/metronome/ui/main)
  code-complete; remaining risk is on-device only: webcam + GPU inference +
  audio latency, tunable via config/default.json once a laptop is available.
  Repo has NO commits yet (branch master, untracked tree) — user has not
  asked to commit.
