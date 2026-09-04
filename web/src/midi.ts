/** Kick from a pedal, over Web MIDI.
 *
 * The lowest-latency input available to a browser: a MIDI event is delivered
 * in about a millisecond and carries its own `timeStamp`, already in the
 * performance clock. For a tool whose output is a millisecond error, a real
 * pedal is the reference standard the other inputs are judged against.
 *
 * Both message shapes are accepted, because "a pedal" means two different
 * things depending on what is plugged in: a sustain pedal on a keyboard sends
 * CC 64, and a drum trigger or pad sends Note On.
 */

export interface MidiHit {
  /** performance.now() domain: MIDIMessageEvent.timeStamp already is. */
  tMs: number;
  velocity: number;
}

const NOTE_ON = 0x90;
const CONTROL_CHANGE = 0xb0;
const CC_SUSTAIN = 64;
/** The MIDI spec's own on/off split for a switch controller. */
const SUSTAIN_ON = 64;

export class MidiInput {
  private access: MIDIAccess | null = null;
  error: string | null = null;
  /** Name of whatever last triggered, for the badge. */
  deviceName: string | null = null;

  get running(): boolean {
    return this.access !== null;
  }

  async start(onKick: (h: MidiHit) => void): Promise<boolean> {
    if (!navigator.requestMIDIAccess) {
      this.error = "no Web MIDI in this browser";
      return false;
    }
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      return false;
    }

    const attach = (port: MIDIInput): void => {
      port.onmidimessage = (e: MIDIMessageEvent): void => {
        const hit = decode(e.data);
        if (hit === null) return;
        this.deviceName = port.name ?? "midi";
        onKick({ tMs: e.timeStamp, velocity: hit });
      };
    };
    for (const port of this.access.inputs.values()) attach(port);
    // A pedal plugged in after the page loaded should just work.
    this.access.onstatechange = (e: MIDIConnectionEvent): void => {
      const port = e.port;
      if (port && port.type === "input" && port.state === "connected") {
        attach(port as MIDIInput);
      }
    };
    return true;
  }

  stop(): void {
    for (const port of this.access?.inputs.values() ?? []) {
      port.onmidimessage = null;
    }
    this.access = null;
  }
}

/** Velocity in 0..1 for a kick message, or null if this message is not one.
 * Exported for test: the byte layout is the kind of thing that is wrong once
 * and then wrong forever, because a pedal is not present in CI. */
export function decode(data: Uint8Array | null): number | null {
  if (!data || data.length < 3) return null;
  const status = data[0] & 0xf0;
  if (status === NOTE_ON) {
    // Note On with velocity 0 is the conventional Note Off. Treating it as a
    // hit doubles every kick.
    return data[2] > 0 ? data[2] / 127 : null;
  }
  if (status === CONTROL_CHANGE && data[1] === CC_SUSTAIN) {
    // Only the press, never the release.
    return data[2] >= SUSTAIN_ON ? 1 : null;
  }
  return null;
}
