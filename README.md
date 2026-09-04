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
| **stomp your foot** | kick (via the mic) |
| a MIDI / sustain pedal | kick |
| Space | kick (fallback) |
| **metronome** | start / stop the click (40-200 bpm) |
| bpm slider | tempo |
| vol slider | kit volume |
| **load song** / **play song** | a backing track to practise against |
| song slider | backing track volume |
| **show zones** | overlay the zone boxes, for aiming and for editing them |

The kick never comes from a hand: there is no foot in frame, and faking one from
a hand would corrupt exactly the timing data the tool exists to measure. Three
real sources feed it instead, and the `kick` badge says which armed.

Stomping is the default because it needs no hardware and, counter-intuitively,
it is the most accurate input in the app: the mic arrives through the same
`AudioContext` the kit plays out of, so the timestamp is compared against the
metronome with no bridge from the camera clock. Wear headphones, or the kick
sample thumping out of your speakers is itself a textbook stomp. A MIDI or
sustain pedal is lower latency still (~1-3 ms) and is picked up automatically
if you plug one in.

Load any local audio file to play along to. It is decoded and played through the
app's own `AudioContext`, not an `<audio>` element, so the song, the click and
the kit share one clock; starting it with the metronome running pins beat 1 to
song position 0, so the timing readout means something against the track. The
file never leaves your machine, same as the camera.

Use headphones if you are playing a song AND using the stomp kick: a backing
track is full of low-frequency kick and bass, which is exactly what the stomp
detector listens for. The `kick` badge says `use headphones` when both are live.

The readout shows the signed error against the nearest metronome beat, so early
and late read differently. Zone geometry lives in
[`config/zones.json`](config/zones.json) and is shared by both implementations.

**No camera?** Append `?demo` to the URL. That drives the same renderer and the
same audio from a scripted groove, with the camera untouched.

### If one drum never fires

Almost always geometry, not detection. The kit is placed inside raw frame x
0.10..0.90 on purpose: MediaPipe emits no landmark until a *whole* hand is in
frame, so a piece sitting in the outer tenth of the picture cannot be struck,
because tracking drops before your hand arrives. Check the `cam` badge for the
resolution; the layout is authored for 16:9 and fitted to whatever your camera
reports ([`web/src/kitfit.ts`](web/src/kitfit.ts)). Turn on **show zones** to see
the real trigger boxes, which sit a little wider than the drawn instruments.

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
