/** Drift guard for the things that live in two files at once.
 *
 * Every one of these was found broken by hand at least once: a `PLAN 8.4`
 * citation pointing at a section that does not exist, a Make target that ran a
 * pytest case instead of the generator it claimed to run, a doc naming a file
 * that had been renamed. A grep finds them once; this finds them every time.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");

function walk(dir: string, exts: string[], out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "dist" || e === "__pycache__" || e.startsWith(".")) {
      continue;
    }
    const p = path.join(dir, e);
    if (statSync(p).isDirectory()) walk(p, exts, out);
    else if (exts.some((x) => e.endsWith(x))) out.push(p);
  }
  return out;
}

/** This file is excluded: its own prose names a deliberately BROKEN citation
 * as an example, and the scanner cannot tell an example from a defect. */
const SELF = "docs.test.ts";

const SOURCES = [
  ...walk(path.join(ROOT, "py", "vdrum"), [".py"]),
  ...walk(path.join(ROOT, "web", "src"), [".ts"]),
  ...walk(path.join(ROOT, "web", "test"), [".ts"]),
  path.join(ROOT, "Makefile"),
  ...walk(path.join(ROOT, "docker"), [".py", "Dockerfile"]),
].filter((f) => !f.endsWith(SELF));

const PLAN = readFileSync(path.join(ROOT, "PLAN.md"), "utf8");
const PLAN_UI = readFileSync(path.join(ROOT, "PLAN-UI.md"), "utf8");

/** Heading numbers PLAN.md actually defines, e.g. "3.1", "9b". */
const HEADINGS = new Set(
  [...PLAN.matchAll(/^#{2,3}\s+([0-9]+[0-9a-z.]*)\.?\s/gm)].map((m) =>
    m[1].replace(/\.$/, ""),
  ),
);

describe("docs consistency", () => {
  it("PLAN.md defines the sections the code cites", () => {
    expect(HEADINGS.size).toBeGreaterThan(10);
    const bad: string[] = [];
    for (const f of SOURCES) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(/PLAN ([0-9][0-9a-z.]*)/g)) {
        const n = m[1].replace(/\.$/, "");
        if (!HEADINGS.has(n)) bad.push(`${path.relative(ROOT, f)}: PLAN ${n}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("every repo-relative path named in PLAN-UI.md exists", () => {
    const missing: string[] = [];
    for (const m of PLAN_UI.matchAll(/`((?:py|web|config|docker|assets)\/[\w./-]+)`/g)) {
      const p = m[1].replace(/:\d+$/, "");
      if (!existsSync(path.join(ROOT, p))) missing.push(p);
    }
    expect(missing).toEqual([]);
  });

  it("the Makefile targets the docs promise all exist", () => {
    const mk = readFileSync(path.join(ROOT, "Makefile"), "utf8");
    const targets = new Set(
      [...mk.matchAll(/^([a-z][\w-]*):/gm)].map((m) => m[1]),
    );
    for (const t of ["image", "py-test", "fixtures", "parity", "typecheck", "test", "assets"]) {
      expect(targets.has(t), `Makefile target ${t}`).toBe(true);
    }
    // `fixtures` must invoke the real generator, not the pytest case that
    // writes to a tmp_path and leaves the fixtures untouched.
    const block = mk.slice(mk.indexOf("\nfixtures:"), mk.indexOf("\nparity:"));
    expect(block).toContain("gen-parity-fixtures");
  });

  it("the shipped config is the one both sides read", () => {
    const shared = path.join(ROOT, "config");
    const served = path.join(ROOT, "web", "public", "config");
    for (const f of ["default.json", "zones.json"]) {
      expect(existsSync(path.join(served, f)), `web/public/config/${f}`).toBe(true);
      expect(
        JSON.parse(readFileSync(path.join(served, f), "utf8")),
        `web/public/config/${f} is stale; run 'make assets'`,
      ).toEqual(JSON.parse(readFileSync(path.join(shared, f), "utf8")));
    }
  });

  it("every zone in the shipped kit has a sample and a drawn piece", () => {
    const zones = JSON.parse(
      readFileSync(path.join(ROOT, "config", "zones.json"), "utf8"),
    ) as { zones: Array<{ id: string }> };
    const audio = readFileSync(path.join(ROOT, "web", "src", "audio.ts"), "utf8");
    const specs = audio.slice(
      audio.indexOf("const SPECS"),
      audio.indexOf("const DEFAULT_ID"),
    );
    const ui = readFileSync(path.join(ROOT, "web", "src", "ui.ts"), "utf8");
    const looks = ui.slice(ui.indexOf("const LOOKS"), ui.indexOf("const FALLBACK"));
    // A zone with neither falls back silently: it plays a snare and draws a
    // generic drum, which looks like a rendering bug rather than a missing entry.
    for (const z of zones.zones) {
      expect(specs, `audio.ts SPECS has no ${z.id}`).toContain(z.id);
      expect(looks, `ui.ts LOOKS has no ${z.id}`).toContain(z.id);
    }
  });
});
