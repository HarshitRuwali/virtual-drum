# Virtual Drum — Webcam Practice Tool

**Goal.** An air-drum kit driven by webcam hand tracking, with a metronome and per-hit
timing error in milliseconds, usable as a real rudiment/timing practice tool.

**Shape.** Python detection prototype (headless, fixture-driven) → browser app (the thing
you actually play). Bare-hand tracking first, with the tracker behind an interface so a
stick-marker tracker drops in later without touching the hit logic.

**Non-goals (this round).** Play-along lesson tracks, scoring against a song, MIDI out,
multi-user. Deliberately excluded to keep the timing core honest first.

---

## 1. Environment constraints (measured 2026-08-18)

`ubuntu-dev` has **no camera, no display, no audio sink**:

| Check | Result |
|---|---|
| `/dev/video*` | absent |
| `lsusb \| grep -i cam` | no match |
| `DISPLAY` / `WAYLAND_DISPLAY` | unset |
| `/dev/snd` | `seq`, `timer` only — no PCM playback device |

So this box cannot run a live prototype or produce a sound. The split follows directly:

- **This box** — detection core, headless, against recorded clips. Container-friendly,
  no devices mounted, fully testable in CI.
- **Your laptop** — anything needing a live camera, a screen, or speakers. That is the
  browser app, and it is where all of Phases 4–5 happen.

This is a better prototyping loop than a live feed regardless of the constraint. Tuning a
threshold against a live camera means you can never separate "the algorithm improved"
from "I played that take differently." Fixed clips with hand-labelled hit times make that
question answerable, and they are what makes the web port verifiable (§7).

## 2. Verified dependency facts

Resolved and executed on this machine, not recalled:

| Piece | Version | Evidence |
|---|---|---|
| `mediapipe` (Python) | 1.0.1 | installs + imports on this box's Python 3.14.4 |
| `@mediapipe/tasks-vision` (JS) | 1.0.1 | published 2026-08-17 |
| `opencv-contrib-python` | 5.0.0.93 | pulled transitively **by** mediapipe |
| `hand_landmarker.task` (float16) | 7,819,105 B | HTTP 200, last-modified 2023-04-26 |
| `tone` | 15.1.22 | optional — likely not needed, see §6 |

Model URL (both platforms use the identical asset):

```
https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/latest/hand_landmarker.task
```

Pin `/1/` instead of `/latest/` for reproducibility; both currently serve the same bytes.

### 2.1 The two runtimes are the same generation

Python and JS MediaPipe are both **1.0.1**, same model, same 21-landmark topology,
same `VIDEO` running mode taking an explicit timestamp:

| | Python | JS |
|---|---|---|
| create | `HandLandmarker.create_from_options(opts)` | `HandLandmarker.createFromOptions(fileset, opts)` |
| per-frame | `detect_for_video(mp.Image, ts_ms)` | `detectForVideo(frame, ts_ms)` |
| landmarks | `result.hand_landmarks` | `result.landmarks` |
| world | `result.hand_world_landmarks` | `result.worldLandmarks` |
| handedness | `result.handedness` | `result.handedness` |
| hands | `num_hands` (**default 1 — set 2**) | `numHands` (**default 1 — set 2**) |

Both return `NormalizedLandmark{x, y, z}` in 0..1 image space (JS also carries
`visibility`). **Phase 3 therefore ports algorithm code only** — the vision layer is
already identical. Note the field-name casing differences above; they are the entire
mechanical surface of the port.

Landmark indices are confirmed identical to the standard topology, verified from the
installed enum:

```
0 WRIST   5 INDEX_FINGER_MCP   9 MIDDLE_FINGER_MCP   17 PINKY_MCP
```

The JS package **bundles its own wasm** (`wasm/vision_wasm_internal.wasm` etc.), so
`FilesetResolver.forVisionTasks()` can point at a locally served copy — no CDN
dependency, and the app works offline.

---

## 3. The two hard problems

Everything else is plumbing. These two decide whether this is a practice tool or a toy.

### 3.1 Hit timestamps must come from the frame clock

A hit's timestamp must be the **capture time of the frame it was detected in**, never
`Date.now()` / `performance.now()` sampled inside your handler.

If you use wall-clock-at-handler, the "you were 18 ms late" readout measures inference
latency and GC pauses, not your playing, and it drifts with CPU load. The number stays
plausible-looking while being meaningless — strictly worse than an obviously broken one.

Concretely, in the browser:

- Drive the loop with **`video.requestVideoFrameCallback(cb)`**, not `requestAnimationFrame`.
  Its metadata gives `mediaTime`, `presentationTime` and `expectedDisplayTime` — genuine
  per-frame capture timing rather than "whenever the compositor got round to it".
- Bridge to the audio clock with **`audioCtx.getOutputTimestamp()`**, which returns
  `{contextTime, performanceTime}` — the one API that relates `performance.now()` to
  `AudioContext.currentTime`.
- Schedule the metronome on the audio clock with a lookahead scheduler (25 ms timer tick,
  schedule ~100 ms ahead, `osc.start(exactContextTime)`). Never `setInterval` for beats.

Both clocks then live on one timebase and the subtraction is honest.

### 3.2 Latency and accuracy pull in opposite directions — and the fix is free budget

A drum stroke is: accelerate down → peak downward velocity → decelerate → strike → rebound.
In image coordinates y grows downward, so track `vy` of the tracked landmark.

- **`vy` zero-crossing** is the true strike instant. Accurate, but known only 1–2 frames
  *after* it happens: 33–66 ms at 30 fps, badly audible for percussion.
- **`vy` peak** happens ~20–40 ms *before* the strike. Fires early, but is a prediction.

Fire on the **velocity peak**, gated by a minimum speed. The apparent downside is the
hidden win: that 20–40 ms of lead time is exactly the budget needed to cover inference
plus audio output latency. Firing "too early" at the peak is what lets the sound land at
the moment your hands expect it.

Rough budget at 60 fps:

| Stage | Cost |
|---|---|
| camera exposure + transfer | 10–20 ms |
| MediaPipe inference (GPU delegate) | 5–15 ms |
| decision lag (peak → decision) | ~1 frame, 17 ms |
| WebAudio output (`baseLatency`+`outputLatency`) | 10–30 ms |
| **total after peak** | **~40–80 ms** |
| **lead gained by firing at peak** | **−20 to −40 ms** |

So the net can plausibly land in the 20–40 ms range, which is usable. Sub-10 ms is not
achievable here and the plan does not pretend otherwise.

**Separate feel from measurement.** Even where the audio still feels marginally late, the
*reported* timing error can be made accurate by subtracting the calibrated constant
offset. Feel has irreducible lag; the numbers do not. Say so in the UI rather than
quietly conflating them.

**Calibration is a feature, not a chore.** Play steady quarters to the click; a consistent
signed bias in your error readout is the pipeline offset, not your playing. Fit it once,
store per user, subtract thereafter. §8 covers the maths.

### 3.3 Landmark choice

Track **landmark 9, `MIDDLE_FINGER_MCP`** — the centre of the hand.

- `WRIST` (0) is the most stable but lags the strike, since the hand rotates about it.
- Fingertips (8/12) lead the motion but jitter hard and move with finger flex.
- The middle MCP is the compromise, and sits roughly where a stick's fulcrum goes —
  which is what makes the Phase 6 marker swap a genuine drop-in rather than a rewrite.

### 3.4 Distance invariance — the non-obvious correctness bug

Normalized coordinates mean a hand further from the camera moves *fewer units* for the
same physical speed. A fixed velocity threshold therefore only works at one distance, and
the kit mysteriously stops responding when you lean back.

Normalize by apparent hand size. Use **palm width** `w = ‖p5 − p17‖` (index MCP to pinky
MCP): that span is rigid, unlike wrist-to-MCP which changes with wrist flex, and unlike
anything involving fingertips.

```
vy_norm = vy / w        # units: palm-widths per second, ~distance invariant
```

Threshold on `vy_norm`, and use `w` itself as the depth proxy (`w ∝ 1/distance`) if
depth-banded zones are wanted later.

### 3.5 Mirroring and handedness

Selfie view must mirror x (`x' = 1 − x`) or the kit feels inverted. **MediaPipe reports
handedness assuming a non-mirrored image**, so mirroring silently swaps the Left/Right
labels. Either mirror only at render time and keep detection in raw coordinates, or flip
the label explicitly. Pick one and write it down — this bug reads as "tracking is fine but
my hi-hat and ride are backwards" and wastes an afternoon.

Aspect ratio: x and y are normalized independently, so a "square" zone in normalized space
is not square on screen. Work in aspect-corrected space `X = x·(W/H)`, `Y = y` for all
distance and zone maths.

---

## 4. Architecture

```
virtual-drum/
├── PLAN.md
├── .agent/CONTINUITY.md
├── Makefile                    # score, sweep, test, parity, build
├── docker/Dockerfile           # verified recipe, §9
├── config/default.json         # SHARED tuning constants — single source of truth
├── tracks/                     # cached landmark tracks (gitignored)
├── fixtures/
│   ├── 01-slow-singles.mp4
│   ├── 01-slow-singles.hits.json
│   └── …
├── py/
│   ├── vdrum/
│   │   ├── filter.py           # OneEuroFilter
│   │   ├── tracker.py          # Tracker protocol + HandTracker
│   │   ├── extract.py          # video → tracks/*.npz  (expensive, once)
│   │   ├── detect.py           # track → hits         ← THE PORTED CORE (cheap)
│   │   ├── zones.py            # zone model + calibration
│   │   ├── pipeline.py         # extract + detect end to end
│   │   ├── score.py            # matching + metrics
│   │   └── cli.py
│   └── tests/
└── web/
    ├── index.html
    ├── src/{filter,tracker,detect,zones}.ts   ← ports of the above
    ├── src/{audio,metronome,ui}.ts            ← browser-only
    └── test/parity.test.ts
```

**`config/default.json` is read by both implementations.** Tuned constants live in exactly
one place; neither side hardcodes them. This is what stops the Python and TS detectors
drifting apart after the first tuning pass.

### 4.1 The tracker interface

The seam that makes Phase 6 cheap. Both trackers emit the same thing per frame:

```python
@dataclass(frozen=True)
class Contact:
    t_ms: float          # FRAME capture time, never wall clock
    hand: str            # "L" | "R"  (or marker id)
    x: float; y: float   # aspect-corrected, un-mirrored
    scale: float         # palm width w, for distance normalization
    conf: float

class Tracker(Protocol):
    def process(self, frame, t_ms: float) -> list[Contact]: ...
```

`HandTracker` wraps MediaPipe. `MarkerTracker` (Phase 6) does HSV blob detection and
returns the same `Contact` list. `detect.py` never learns which one it has.

---

## 5. The hit detection algorithm

Per hand, per frame:

```
1.  c = tracker contact for this hand           # skip hand if absent this frame
2.  y_f = one_euro(c.y, t_ms)                   # jitter filter, §5.1
3.  vy  = (y_f - y_f_prev) / dt                 # +ve = downward in image coords
4.  vy_n = vy / c.scale                         # distance-invariant, §3.4

    state machine:
    IDLE:
        if vy_n > V_MIN:            → DESCENDING, peak = vy_n, peak_t = t_ms
    DESCENDING:
        if vy_n > peak:               peak = vy_n; peak_t = t_ms
        elif vy_n < peak * DECEL_RATIO:
                                     → FIRE(peak_t, peak); → REFRACTORY
        elif vy_n < V_MIN * 0.5:     → IDLE          # faded out, no strike
    REFRACTORY:
        if t_ms - fire_t > REFRAC_MS: → IDLE

5.  on FIRE:
        zone     = zones.lookup(c.x, y_at_peak, c.scale)
        velocity = clamp((peak - V_MIN) / (V_MAX - V_MIN), 0, 1)   # loudness
        report_t = peak_t + OFFSET_MS        # calibrated, §8 — reporting only
        emit Hit(report_t, zone, velocity, hand)
        play sound NOW                       # audio fires at detection, not report_t
```

The split on the last two lines is the §3.2 trick made concrete: **audio plays at peak
detection** (buying back latency), while **the reported timestamp is offset** to the true
strike instant (keeping the feedback numbers honest).

### 5.1 Why One Euro, not a moving average

Landmark jitter needs smoothing, but a fixed low-pass adds lag exactly when the hand is
fastest — i.e. destroys the thing being measured. The **One Euro filter** adapts its
cutoff to speed: heavy smoothing when slow, almost none when fast.

```
dx = (x - x_prev)/dt ;  dx_hat = lowpass(dx, alpha(D_CUTOFF))
cutoff = MIN_CUTOFF + BETA * |dx_hat|
x_hat  = lowpass(x, alpha(cutoff))
```

Starting points, all `[tune]` in Phase 2: `MIN_CUTOFF ≈ 1.0` Hz, `BETA ≈ 0.05`,
`D_CUTOFF = 1.0` Hz. Raise `BETA` if strikes feel mushy or arrive late; raise
`MIN_CUTOFF` if a still hand drifts.

### 5.2 Constants, with reasoning for the starting values

| Constant | Start | Reasoning |
|---|---|---|
| `V_MIN` | 0.8 palm-widths/s | below this it's hand movement, not a strike |
| `V_MAX` | 8.0 | maps to full velocity/loudness |
| `DECEL_RATIO` | 0.6 | fire once speed drops to 60% of peak = decel confirmed |
| `REFRAC_MS` | 60 ms | per hand → 16 hits/s/hand; 16ths at 220 bpm one-handed |
| `OFFSET_MS` | 25 ms | peak→strike lead; **replaced by per-user fit in Phase 5** |
| `MIN_CONF` | 0.5 | MediaPipe default; raise if false hits in clutter |

All of these are guesses until Phase 2 sweeps them against fixtures. They are written down
so the sweep has a starting point and so nobody later mistakes them for tuned values.

---

## 6. Zones, audio, and the practice loop

### 6.1 Zone model and calibration

Zones are axis-aligned rects in aspect-corrected normalized space, optionally banded by
`scale` (depth). Calibration flow: hold hand at the snare position → press a key → sample
~15 frames → take the **median** (robust to a stray frame) → store rect with padding.

```json
{ "id": "snare", "x": [0.28, 0.52], "y": [0.55, 0.80], "scale": [0.00, 1.00],
  "sample": "snare.wav" }
```

Start with 5: kick, snare, hi-hat, tom, ride. Kick is the awkward one — a foot is not in
frame. Options: a second zone triggered by a hand dip low in frame, a keyboard/pedal
binding, or drop kick from v1. **Recommend a keyboard binding for v1** and revisit; a fake
hand-kick corrupts exactly the timing data the tool exists to measure.

### 6.2 Audio

Plain WebAudio. `tone` is listed but probably unnecessary — one-shot samples and a
metronome do not justify the dependency.

- `new AudioContext({ latencyHint: 'interactive' })`; read `baseLatency` + `outputLatency`
  and feed them into the §8 offset.
- Pre-decode every sample to an `AudioBuffer` at load. Never decode on hit.
- Per hit: fresh `BufferSourceNode` → gain (= velocity) → destination, `start()` with no
  argument for immediate playback.
- **Choking:** closed hi-hat must cut the open one. Keep a per-choke-group active source
  and `stop()` the previous on retrigger. Without this, hi-hat work sounds like mush.

### 6.3 Metronome and the timing readout

Grid times: `t_n = t0 + n · (60 / bpm) / subdiv`, all in `AudioContext` time.

```
error_ms = hit.report_t_in_audio_time − nearest_grid_time
```

Signed: negative = early, positive = late. Surface three things, not one:

1. **Last hit** — big signed number, colour-coded.
2. **Rolling stddev over last 32 hits** — the number that actually measures your timing.
3. **Scatter of the last 32** against the grid — reveals whether you rush fills, drag on
   the backbeat, or are just noisy. A mean and a stddev hide all of that.

Mean error is *not* a skill metric here: a consistent mean is a calibration constant
(§8), not a playing flaw. Report it separately and label it as such.

---

## 7. Verification strategy

### 7.1 Scoring (Phase 2)

Match predicted hits to ground truth: greedy by ascending `|Δt|`, one-to-one, within a
`±50 ms` window. Then:

- `precision`, `recall`, `F1` from TP / FP / FN
- on matched pairs: **`mean(Δt)` = bias**, **`stddev(Δt)` = jitter**

**Optimize `F1` and `stddev`, never `bias`.** Bias is a constant you subtract (§8);
jitter is irreducible pipeline quality. Conflating them leads to "improving" the detector
by tuning out an offset that calibration would have removed for free.

Keep the match window honest — widening it inflates precision by absorbing bad hits.

### 7.2 The parity gate (Phase 3)

Because both runtimes share model and version, the port is checkable rather than
vibe-checked: **feed the same fixture through Python and TS, assert the same hit list**
within ±1 frame.

One trap: browser `<video>` decode may drop or duplicate frames, where OpenCV's decode is
deterministic — that alone would make the test flake. **Drive the parity test from
pre-extracted PNG frames**, not an mp4 element. Live camera capture keeps using
`requestVideoFrameCallback`; only the test is frame-fed.

This is the highest-value test in the project: it converts the whole port from a
correctness risk into a pass/fail check.

---

## 8. Calibration maths

Two distinct offsets, routinely conflated:

- **`OFFSET_MS`** (detection): velocity peak → true strike. A property of *your stroke*,
  ~20–40 ms, fitted from fixtures in Phase 2.
- **`OUTPUT_LATENCY_MS`** (audio): `ctx.baseLatency + ctx.outputLatency`. A property of
  *the machine*, read from the API, not fitted.

For the reported number:

```
report_t = peak_t + OFFSET_MS
error    = report_t − nearest_grid_t
```

Per-user fit in Phase 5: have them play 32 quarter notes to the click, take
`median(error)` (median, not mean — one fumbled note shouldn't move it), and fold it into
`OFFSET_MS`. Show the fitted value; if it exceeds ~60 ms something is wrong upstream and
silently absorbing it would hide a real bug.

---

## 9. Container recipe

Container-first per the standing policy, and trivially satisfied because the Python side
is headless. Verified in a real `python:3.14-slim` container, not assumed:

The runtime dependency chain surfaces **one library at a time**, each only when the
previous is satisfied. Found by iterating in a real container:

1. `import mediapipe` → `ImportError: libxcb.so.1`. mediapipe pulls
   `opencv-contrib-python` (the GUI build); swap for `opencv-contrib-python-headless`.
2. `create_from_options()` → `OSError: libEGL.so.1`. Add `libegl1`.
3. `create_from_options()` → `OSError: libGLESv2.so.2`. Add `libgles2`.

Final set: **`libegl1 libgles2 libgl1 libglib2.0-0`** + headless OpenCV. Verified end to
end (`create_from_options OK`, 600 frames processed) in `docker/Dockerfile`, image 1.13 GB.

**`import mediapipe` succeeding proves nothing** — the whole GL chain is `dlopen`ed lazily
inside task creation. `docker/smoke.py` therefore calls `create_from_options()`; an
import-only smoke test would have passed at every one of the three broken stages above.

No camera, display, or sound device is ever mounted.

---

## 9b. Measured throughput — and why the pipeline splits in two

Benchmarked in the container on this box (CPU, 640×480, 600 frames @60 fps):

```
inference 14.66 ms/frame -> 68 fps ceiling   (empty frame = FLOOR cost)
end-to-end 9.62s for a 10.0s clip = 1.0x realtime
```

That is the **floor**: no hand in frame, so only the palm detector ran. With two hands
tracked, expect meaningfully worse — call it 0.4–0.6× realtime until measured on real
fixtures. No GPU delegate here.

The consequence is architectural. A Phase 2 threshold sweep over ~10 fixtures is minutes
of inference *per parameter combination*, which makes a real sweep impossible. So the
pipeline splits:

| Stage | Cost | Runs |
|---|---|---|
| `extract.py`: video → landmark track (`tracks/*.npz`) | expensive, ~1× realtime | **once per fixture** |
| `detect.py`: track → hits | pure numpy, sub-ms | **thousands of times per sweep** |

`detect.py` must therefore consume a *track*, never a video. This is the same boundary the
`Tracker` interface (§4.1) already draws, so it costs nothing — but only if the split is
built in from the start. Retrofitting it after `detect.py` has grown a `VideoCapture`
inside is painful, which is why it is called out here rather than discovered in Phase 2.

It also makes the §7.2 parity gate cheaper and stricter: ship the cached track as the test
fixture and both implementations run identical *input numbers*, removing video decode from
the comparison entirely.

## 10. Phases

| # | Deliverable | Acceptance | Where |
|---|---|---|---|
| 0 | `fixtures/*.mp4` + hand-labelled `*.hits.json` | 6–10 clips, 60 fps, labelled | laptop |
| 1 | headless detector, containerised | `vdrum detect clip.mp4 → hits.json` | this box |
| 2 | scoring harness + tuned constants | `make score` table; F1 & stddev reported | this box |
| 3 | TS port | **parity gate green** (§7.2) | either |
| 4 | audio + zones + calibration | playable kit, 5 zones | laptop |
| 5 | metronome + timing readout + per-user fit | stddev + scatter live | laptop |
| 6 | marker tracker *(deferred)* | same `Tracker` interface, F1 ≥ hands | either |

### Phase 0 — fixtures (do this first, it gates everything)

Record at 60 fps: slow singles, steady 8ths to a click, fast alternating, a deliberately
sloppy take, one in poor lighting, one with hands crossing (hats↔snare), one leaning
back from the camera (exercises §3.4), one with a non-drumming gesture like scratching
your head (false-positive bait).

Label hit times by hand. Tedious and worth it — every later number is measured against
this, so an unlabelled or sloppily labelled fixture set silently caps the whole project's
credibility. Audio-assisted labelling helps: tap a hard surface while recording and pick
transients off the waveform.

---

## 11. Risks, honestly

- **60 fps may not be available.** Many webcams do 60 fps only at reduced resolution or
  only in MJPG. Verify in Phase 0. At 30 fps the latency budget in §3.2 roughly doubles
  and predictive firing stops being optional.
- **No rebound.** Air drumming has no surface to bounce off, so doubles and buzz rolls
  will not behave like a real kit. This tool is honest for timing, independence, limb
  coordination and pattern work; it is **not** honest for stick technique. Worth knowing
  before building rather than after.
- **Kick has no good answer** without a foot in frame (§6.1).
- **Hands crossing** breaks handedness tracking; the crossing fixture exists to catch it.
- **Fixture labelling is the schedule risk.** It is the least interesting task here and
  the one everything else depends on.
