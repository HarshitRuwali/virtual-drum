/** The camera precondition (PLAN 9.1).
 *
 * `getUserMedia` needs a secure context. On `http://<lan-ip>` Chrome does not
 * reject the permission, it never defines `navigator.mediaDevices` at all, so
 * the unguarded call dies on "Cannot read properties of undefined" and the
 * splash shows that string to the user. Since the camera lives on a different
 * machine than the server (PLAN 1), this is the ordinary path, not an edge case.
 *
 * This drives the real `Tracker.start()`, so the guard cannot be deleted from
 * tracker.ts without failing here.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { configFromDict } from "../src/config";
import { Tracker } from "../src/tracker";

// The shipped config, not a hand-written stub: a stub silently rots as the
// schema grows, and Tracker reads more of it than this file cares about.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const cfg = configFromDict(
  JSON.parse(
    readFileSync(path.join(HERE, "..", "..", "config", "default.json"), "utf8"),
  ),
);

/** Install the globals `Tracker.start()` reads, then undo it. */
function origin(secure: boolean, mediaDevices: unknown): void {
  vi.stubGlobal("window", { isSecureContext: secure });
  vi.stubGlobal("location", { origin: "http://10.10.50.125:5199" });
  vi.stubGlobal("navigator", { mediaDevices });
}

afterEach(() => vi.unstubAllGlobals());

describe("camera precondition", () => {
  it("names TLS as the cause on an insecure origin", async () => {
    // What Chrome actually presents over plain http off localhost.
    origin(false, undefined);
    const t = new Tracker(cfg);
    await expect(t.start({} as HTMLVideoElement)).rejects.toThrow(
      /not a secure context/,
    );
  });

  it("quotes the origin, so the message says which URL is wrong", async () => {
    origin(false, undefined);
    const t = new Tracker(cfg);
    await expect(t.start({} as HTMLVideoElement)).rejects.toThrow(
      /http:\/\/10\.10\.50\.125:5199/,
    );
  });

  it("still refuses when the context is secure but the API is absent", async () => {
    // Firefox with media.navigator.enabled=false, and any embedded webview
    // that ships no camera API: same dead end, same unhelpful TypeError.
    origin(true, {});
    const t = new Tracker(cfg);
    await expect(t.start({} as HTMLVideoElement)).rejects.toThrow(
      /not a secure context/,
    );
  });

  it("gets out of the way once the context is secure", async () => {
    // The guard must not become the thing that blocks a working browser: past
    // it, the real getUserMedia call is reached.
    const getUserMedia = vi.fn().mockResolvedValue({ getVideoTracks: () => [] });
    origin(true, { getUserMedia });
    const t = new Tracker(cfg);
    const video = { play: vi.fn().mockResolvedValue(undefined) };
    await t.start(video as unknown as HTMLVideoElement);
    expect(getUserMedia).toHaveBeenCalledOnce();
  });
});
