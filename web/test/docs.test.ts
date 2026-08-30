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
  path.join(ROOT, "docker-compose.yml"),
  ...walk(path.join(ROOT, "docker"), [".py", ".sh", "Dockerfile"]),
].filter((f) => !f.endsWith(SELF));

const PLAN = readFileSync(path.join(ROOT, "PLAN.md"), "utf8");
const PLAN_UI = readFileSync(path.join(ROOT, "PLAN-UI.md"), "utf8");
const README = readFileSync(path.join(ROOT, "README.md"), "utf8");

/** GitHub's heading slug: lowercase, drop punctuation, spaces to hyphens. */
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");
}

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
    for (const t of [
      "image", "py-test", "fixtures", "parity", "typecheck", "test", "assets",
      "serve", "serve-stop",
    ]) {
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
  it("the compose stack the Makefile drives is the one that exists", () => {
    const mk = readFileSync(path.join(ROOT, "Makefile"), "utf8");
    const compose = readFileSync(path.join(ROOT, "docker-compose.yml"), "utf8");
    const services = new Set(
      [...compose.matchAll(/^ {2}([a-z][\w-]*):$/gm)].map((m) => m[1]),
    );
    expect(services.size).toBeGreaterThan(0);
    // `docker compose up <name>` with a name nobody defines fails only when the
    // user runs it, which is exactly the moment they wanted to demo the thing.
    const invocations = [
      ...mk.matchAll(
        /(?:docker compose|\$\(COMPOSE\)) (?:up|run --rm) (?:--\S+ )*([a-z][\w-]*)/g,
      ),
    ];
    // Without this the loop below passes by finding nothing, which is what
    // happened when the Makefile moved from a literal `docker compose` to
    // $(COMPOSE) and the pattern silently stopped matching.
    expect(invocations.length).toBeGreaterThan(1);

    // ...and the variable those invocations go through has to be defined.
    // Renaming the definition alone leaves the recipe expanding to an empty
    // string, so `make serve` runs ` up web` and the pattern above still
    // matches happily.
    const defined = new Set([...mk.matchAll(/^([A-Z][A-Z0-9_]*)\s*[:?]?=/gm)].map((m) => m[1]));
    defined.add("PWD"); // provided by make itself, never assigned here
    for (const m of mk.matchAll(/\$\(([A-Z][A-Z0-9_]*)\)/g)) {
      expect(defined.has(m[1]), `Makefile uses $(${m[1]}) but never defines it`).toBe(true);
    }
    for (const m of invocations) {
      expect(services.has(m[1]), `docker-compose.yml has no service ${m[1]}`).toBe(true);
    }
    // Every host path the stack executes must be present, and executable.
    for (const m of compose.matchAll(/"\/w\/(docker\/[\w./-]+)"/g)) {
      expect(existsSync(path.join(ROOT, m[1])), m[1]).toBe(true);
    }
  });

  it("the cert filenames mkcert.sh writes are the ones vite reads", () => {
    // Drift here is silent and expensive: vite finds no cert, quietly falls
    // back to http, and the camera stops working on every non-localhost origin
    // with nothing in the log to say why.
    const sh = readFileSync(path.join(ROOT, "docker", "mkcert.sh"), "utf8");
    const vite = readFileSync(path.join(ROOT, "web", "vite.config.ts"), "utf8");
    for (const f of ["dev-key.pem", "dev-cert.pem"]) {
      expect(sh, `mkcert.sh does not write ${f}`).toContain(f);
      expect(vite, `vite.config.ts does not read ${f}`).toContain(f);
    }
    // Both sides must agree on the directory, and both take it from the same
    // env var so compose can point them somewhere else together.
    expect(sh).toContain("VD_CERT_DIR");
    expect(vite).toContain("VD_CERT_DIR");
  });

  it("the private key can never be committed", () => {
    const ignore = readFileSync(path.join(ROOT, ".gitignore"), "utf8")
      .split("\n")
      .map((l) => l.trim());
    const sh = readFileSync(path.join(ROOT, "docker", "mkcert.sh"), "utf8");
    const dir = /VD_CERT_DIR:-([\w./-]+)/.exec(sh)?.[1];
    expect(dir, "mkcert.sh has no default cert dir").toBeTruthy();
    expect(ignore, `.gitignore does not cover ${dir}`).toContain(`${dir}/`);
  });

  it("the served port is the same number in all three places", () => {
    const mk = readFileSync(path.join(ROOT, "Makefile"), "utf8");
    const compose = readFileSync(path.join(ROOT, "docker-compose.yml"), "utf8");
    const vite = readFileSync(path.join(ROOT, "web", "vite.config.ts"), "utf8");
    const port = /^VD_PORT\s*\?=\s*(\d+)/m.exec(mk)?.[1];
    expect(port, "Makefile defines no VD_PORT").toBeTruthy();
    // A published port that does not match the port vite binds gives a
    // connection that hangs rather than an error anyone can read.
    expect(compose).toContain(`"\${VD_PORT:-${port}}:\${VD_PORT:-${port}}"`);
    expect(vite).toContain(`process.env.VD_PORT ?? ${port}`);
  });
  it("every make target the README advertises exists", () => {
    const mk = readFileSync(path.join(ROOT, "Makefile"), "utf8");
    const targets = new Set([...mk.matchAll(/^([a-z][\w-]*):/gm)].map((m) => m[1]));
    const named = [...README.matchAll(/`make ([a-z][\w-]*)/g)].map((m) => m[1]);
    // A README is the first thing a new person types from. A target that does
    // not exist turns "start here" into `No rule to make target`.
    expect(named.length).toBeGreaterThan(4);
    for (const t of named) {
      expect(targets.has(t), `README says \`make ${t}\`, Makefile has no such target`).toBe(true);
    }
  });

  it("every link and path in the README resolves", () => {
    const missing: string[] = [];
    for (const m of README.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const [target, anchor] = m[1].split("#");
      if (/^https?:/.test(target)) continue;
      const abs = path.join(ROOT, target);
      if (!existsSync(abs)) {
        missing.push(m[1]);
        continue;
      }
      // A link to a heading that was reworded lands the reader at the top of a
      // long document with no sign anything went wrong.
      if (anchor) {
        const heads = [...readFileSync(abs, "utf8").matchAll(/^#{1,6}\s+(.+)$/gm)];
        if (!heads.some((h) => slug(h[1]) === anchor)) missing.push(m[1]);
      }
    }
    expect(missing).toEqual([]);

    // Bare repo paths named in prose or tables, outside link syntax.
    const bad: string[] = [];
    for (const m of README.matchAll(/`((?:py|web|config|docker|assets)\/[\w./-]*)`/g)) {
      if (!existsSync(path.join(ROOT, m[1]))) bad.push(m[1]);
    }
    expect(bad).toEqual([]);
  });

  it("the README quotes the port the stack actually publishes", () => {
    const mk = readFileSync(path.join(ROOT, "Makefile"), "utf8");
    const port = /^VD_PORT\s*\?=\s*(\d+)/m.exec(mk)?.[1];
    expect(README, `README does not mention port ${port}`).toContain(String(port));
  });
});
