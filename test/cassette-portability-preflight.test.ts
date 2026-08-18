import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir, homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { cassettePortabilityPreflight } from "../src/run/cassette.js";
import type { Scenario } from "../src/types.js";

// A cassette stores `scenario.session` / `scenarioSource` relative to its OWN directory. If reaching
// them means climbing out of the project tree, the stored relatives resolve only from this exact
// filesystem layout — the cassette is uncommittable, and `verify-cassettes` reports it permanently
// `unverifiable` for staleness. Two consumers paid for that discovery after the run.
//
// The check this replaces was "does the written cassette resolve its own references", which is VACUOUS:
// `resolve(dir, relative(dir, X)) === X` always holds on the recording machine. These tests exist to
// pin the predicate that can actually fire.

/** A git repo with `sessions/default.yaml`, `scenarios/s.yaml`, and a `cassettes/` sibling. */
function repo(): { root: string; session: string; scenario: string } {
  const root = mkdtempSync(join(tmpdir(), "cwh-port-"));
  for (const d of ["sessions", "scenarios", "cassettes"]) mkdirSync(join(root, d), { recursive: true });
  const session = join(root, "sessions", "default.yaml");
  const scenario = join(root, "scenarios", "s.yaml");
  writeFileSync(session, "model: opus\n");
  writeFileSync(scenario, "name: s\nprompt: p\n");
  spawnSync("git", ["-C", root, "init", "-q"], { encoding: "utf8" });
  return { root, session, scenario };
}

const scn = (session: string): Scenario => ({ name: "s", prompt: "p", session, assert: [] }) as unknown as Scenario;

describe("cassettePortabilityPreflight — climb-out, in both directions", () => {
  it("silent when the cassette and its references share the tree (the happy path)", () => {
    const { root, session, scenario } = repo();
    const v = cassettePortabilityPreflight(scn(session), join(root, "cassettes", "s.cassette.json"), scenario);
    expect(v.kind).toBe("ok");
  });

  // Direction 1 — the reported case: `--out` somewhere outside the repo.
  it("warns when the CASSETTE is written outside the tree", () => {
    const { session, scenario } = repo();
    const out = join(mkdtempSync(join(tmpdir(), "cwh-elsewhere-")), "s.cassette.json");
    const v = cassettePortabilityPreflight(scn(session), out, scenario);
    expect(v.kind).toBe("warn");
    if (v.kind !== "warn") return;
    expect(v.message).toMatch(/cassette would be written outside/);
    expect(v.message).toMatch(/can't verify ⇒ not green/);
  });

  // Direction 2 — the mirror image the first draft of this check missed entirely: cassette in-repo,
  // session outside it. Same broken relative, no warning under a cassette-containment test.
  it("warns when the SESSION lives outside the tree", () => {
    const { root, scenario } = repo();
    const outsideSession = join(mkdtempSync(join(tmpdir(), "cwh-sess-")), "default.yaml");
    writeFileSync(outsideSession, "model: opus\n");
    const v = cassettePortabilityPreflight(scn(outsideSession), join(root, "cassettes", "s.cassette.json"), scenario);
    expect(v.kind).toBe("warn");
    if (v.kind !== "warn") return;
    expect(v.message).toMatch(/`session`/);
    expect(v.message).toMatch(/lives outside/);
  });

  // `parseScenarioFile` resolves a file-relative session to absolute but deliberately leaves `~/…`
  // untouched, and a raw `~/x` looks RELATIVE to path.relative — it would resolve under the cwd and be
  // judged in-tree. Expansion has to happen before the containment test, not as a nicety.
  it("expands `~` before testing containment (otherwise this case is silently clean)", () => {
    const { root, session, scenario } = repo();
    const cassette = join(root, "cassettes", "s.cassette.json");
    // Control: an in-tree session warns about nothing.
    expect(cassettePortabilityPreflight(scn(session), cassette, scenario).kind).toBe("ok");
    // The case: `~/…` is a HOME path, outside this repo, so it must warn. Without expansion it would
    // look relative to path.relative, resolve under the cwd, and be judged in-tree — silently clean.
    // (The rendered message tildeifies the path back for display; the warning FIRING is the proof.)
    // The cwd MUST be inside the reference root for this to isolate the expansion: unexpanded,
    // `~/x` resolves to `<cwd>/~/x` — which is in-tree here, so a non-expanding check reports OK.
    // Run it from anywhere else and the test passes for the wrong reason (it was, before this comment).
    const cwd = process.cwd();
    try {
      process.chdir(root);
      const v = cassettePortabilityPreflight(scn("~/some-session.yaml"), cassette, scenario);
      expect(v.kind).toBe("warn");
      if (v.kind !== "warn") return;
      expect(v.message).toContain("session");
    } finally {
      process.chdir(cwd);
    }
    expect(homedir().length).toBeGreaterThan(0);
  });

  it("an `(inline)` session is exempt — the sentinel is stored verbatim, never as a path", () => {
    const { root, scenario } = repo();
    const v = cassettePortabilityPreflight(scn("(inline)"), join(root, "cassettes", "s.cassette.json"), scenario);
    expect(v.kind).toBe("ok");
  });

  // The false-positive that would make this warning worthless: with no git and no scenario source, the
  // root must fall back to CWD, not to the session file's own directory — `sessions/` and `cassettes/`
  // are conventionally SIBLINGS, so a session-dir anchor would warn on every default record.
  it("falls back to cwd, so a sessions/ + cassettes/ sibling layout stays silent without git", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-nogit-"));
    for (const d of ["sessions", "cassettes"]) mkdirSync(join(root, d), { recursive: true });
    const session = join(root, "sessions", "default.yaml");
    writeFileSync(session, "model: opus\n");
    const cwd = process.cwd();
    try {
      process.chdir(root);
      const v = cassettePortabilityPreflight(scn(session), join(root, "cassettes", "s.cassette.json"), undefined);
      expect(v.kind).toBe("ok");
    } finally {
      process.chdir(cwd);
    }
  });

  it("names the scenarioSource too when that is the reference that strays", () => {
    const { root, session } = repo();
    const strayScenario = join(mkdtempSync(join(tmpdir(), "cwh-scn-")), "s.yaml");
    writeFileSync(strayScenario, "name: s\nprompt: p\n");
    // Anchor the root on the STRAY scenario: its own tmp dir is not a repo, so the root falls back to
    // cwd (this repo), which contains neither the session nor the cassette — both stray.
    const v = cassettePortabilityPreflight(scn(session), join(root, "cassettes", "s.cassette.json"), strayScenario);
    expect(v.kind).toBe("warn");
    if (v.kind !== "warn") return;
    expect(v.message).toMatch(/session|scenarioSource/);
  });

  it("resolves a relative planned path against cwd before testing it", () => {
    // `defaultCassettePath` returns the RELATIVE string "cassettes/x.cassette.json"; treating that as
    // absolute would compare a bare path against an absolute root and warn on every default record.
    const { root, session, scenario } = repo();
    const cwd = process.cwd();
    try {
      process.chdir(root);
      const v = cassettePortabilityPreflight(scn(session), join("cassettes", "s.cassette.json"), scenario);
      expect(v.kind).toBe("ok");
    } finally {
      process.chdir(cwd);
    }
    expect(resolve(root)).toBeTruthy();
  });
});
