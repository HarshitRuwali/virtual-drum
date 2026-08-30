# Virtual Drum

An air-drum kit played with your hands in front of a webcam, with a metronome
and a per-hit timing error in milliseconds. Built to be a real rudiment and
timing practice tool, so the measurement is the point: hit times come from the
camera's capture clock, not from whenever the browser got round to drawing.

Nothing is uploaded. Tracking, synthesis and scoring all run in the page.

## Requirements

Docker, and a browser with a camera. That is the whole list: Python and Node
both run in containers, so nothing is installed on the host.

## Start

```sh
make assets   # one time: fetches the 7.8 MB hand model, installs web deps
make serve    # https on 0.0.0.0:5199
```

`make serve` prints the URLs. Open one from the machine holding the camera and
click **start**.

Your browser will warn about the certificate the first time. Proceed through
it. This is expected and the camera still works: a certificate error does not
stop an origin from being a secure context.

**Why HTTPS at all.** `getUserMedia` requires a secure context. `http://localhost`
is exempt, so serving over plain HTTP looks fine on the machine running the
server and then fails on every other device, and it fails badly: Chrome does not
reject the permission, it leaves `navigator.mediaDevices` undefined, so the app
dies on an error that mentions neither the camera nor TLS. `make serve` issues a
self-signed certificate covering localhost and every address this host answers
on. Details in [PLAN 9.1](PLAN.md#91-serving-the-app-why-the-dev-server-must-speak-tls).

Stop it with `make serve-stop`.

## Playing

Six pieces, laid out as a right-handed kit in the mirrored view: kick, snare,
hi-hat, tom, crash, ride. Strike downward; a hit fires on the velocity peak, not
at the bottom of the stroke, which is what buys back the tracking and audio
latency.

| Control | Does |
|---|---|
| Space | kick |
| **metronome** | start / stop the click (40-200 bpm) |
| bpm slider | tempo |
| vol slider | kit volume |
| **show zones** | overlay the zone boxes, for aiming and for editing them |

The kick is on the keyboard on purpose: there is no foot in frame, and a faked
hand-kick would corrupt the timing data the tool exists to measure.

The readout shows the signed error against the nearest metronome beat, so early
and late read differently. Zone geometry lives in
[`config/zones.json`](config/zones.json) and is shared by both implementations.

**No camera?** Append `?demo` to the URL. That drives the same renderer and the
same audio from a scripted groove, with the camera untouched.

## Development

| Command | Does |
|---|---|
| `make test` | the full gate: Python tests, TS parity, typecheck |
| `make py-test` | Python detection core, in `python:3.14-slim` |
| `make parity` | TS port vs Python-generated fixtures, bit-exact |
| `make typecheck` | `tsc --noEmit` |
| `make fixtures` | regenerate parity fixtures from the Python side |
| `make assets` | fetch the hand model, install web deps, sync served config |
| `make deps` | web dependencies only |
| `make serve` | dev server, HTTPS on `0.0.0.0` |
| `make serve-stop` | tear the stack down |

The Python core is headless and fixture-driven: it consumes cached landmark
tracks, never video, because inference runs at about 1x realtime and a parameter
sweep would otherwise be impossible. The browser app is a port of that same
detection code, held to it by a parity gate that replays Python-generated
fixtures through the TypeScript and compares bit-exactly.

## Layout

| Path | Holds |
|---|---|
| `py/vdrum/` | detection core, scoring, parameter sweep, CLI |
| `web/src/` | the app: tracker, detector port, kit renderer, synthesis |
| `web/test/` | parity gate, geometry, drift guards |
| `config/` | tuned constants and zone geometry, read by both sides |
| `docker/` | Python image, certificate issuance |

## Documents

- [`PLAN.md`](PLAN.md) is the detector: the timing argument, the algorithm and
  its constants, the container recipe, the verification strategy.
- [`PLAN-UI.md`](PLAN-UI.md) is the instrument: the drawn kit, strike feedback,
  the kit sound, the on-screen readouts.
- [`.agent/CONTINUITY.md`](.agent/CONTINUITY.md) is the running log of decisions
  and measurements.
