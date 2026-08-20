import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, copyFileSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveCassetteSessionPath } from "../src/run/cassette.js";

/**
 * `--session` — the relocation escape hatch.
 *
 * A cassette stores `session:` RELATIVE TO ITS OWN DIRECTORY (`relative(dirname(cassettePath), …)`) and
 * resolves it back with `join(cassetteDir, sessionPath)`. Those agree only while the cassette sits where it
 * was written, so any move — `git mv`, a repo reorganisation, a copy into another project — made skill
 * staleness permanently `unverifiable-skill` with **no way to say where the tree went**. The only remedies
 * were moving the file back or re-recording.
 *
 * These tests pin the fix and, just as importantly, the three things that must NOT happen: a wrong override
 * must not manufacture a false green, a batch must not take one session, and a typo'd path must not be
 * silently ignored.
 *
 * Token-free: `replay` and `verify-cassettes` re-check a recorded cassette and never call a model.
 */
const CLI = resolve("dist/cli.js");
const FIXTURE = resolve("examples/replays/example-pdf-skill.cassette.json");
const REAL_SESSION = resolve("examples/sessions/default.yaml");
const CAN = existsSync(CLI) && existsSync(FIXTURE);

/** Copy the committed fixture somewhere its recorded `../sessions/default.yaml` cannot resolve. */
function relocate(): string {
  const d = mkdtempSync(join(tmpdir(), "cwh-reloc-"));
  const dest = join(d, "example-pdf-skill.cassette.json");
  copyFileSync(FIXTURE, dest);
  return dest;
}

function run(args: string[]) {
  const r = spawnSync("node", [CLI, ...args], { encoding: "utf8" });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
}

describe("resolveCassetteSessionPath — the single join every consumer shares", () => {
  // It was duplicated byte-identically in skillSourceDirs, buildSessionFingerprint and
  // loadCassetteSessionFolders. An override reaching only one produces a split-brain cassette: skill
  // staleness resolved against the override while session-shape or folder resolution still resolves
  // against the cassette dir — a QUIET disagreement nothing names.
  it("joins a relative recorded path against the cassette dir", () => {
    expect(resolveCassetteSessionPath("../s/x.yaml", "/c/replays")).toEqual({ path: "/c/s/x.yaml", source: "cassette-relative" });
  });

  it("an override wins over the recorded path, and says so", () => {
    expect(resolveCassetteSessionPath("../s/x.yaml", "/c/replays", "/elsewhere/y.yaml")).toEqual({
      path: "/elsewhere/y.yaml",
      source: "override",
    });
  });

  it("an absolute recorded path is used as given", () => {
    expect(resolveCassetteSessionPath("/abs/x.yaml", "/c/replays").source).toBe("as-given");
  });

  it("an inline scenario has no session FILE, so an override cannot apply", () => {
    // Guards against a future change that lets `--session` silently "resolve" a scenario that never had a
    // file — it would report a fresh hash for a tree the recording never used.
    expect(resolveCassetteSessionPath("(inline)", "/c", "/elsewhere/y.yaml")).toEqual({ path: "(inline)", source: "inline" });
  });
});

describe.skipIf(!CAN)("--session resolves a relocated cassette", () => {
  it("THE OBJECTIVE: a moved cassette verifies fresh when told where the session went", () => {
    const moved = relocate();

    // Baseline: unverifiable, and the drift gate fails on it. This is the state the flag exists to escape.
    expect(run(["replay", moved, "--fail-on-skill-drift"]).code, "a relocated cassette should be unverifiable without help").not.toBe(0);
    expect(run(["verify-cassettes", moved]).code, "verify-cassettes exits 3 on unverifiable").toBe(3);

    // With the override both commands resolve the real tree and verify it fresh.
    expect(run(["replay", moved, "--session", REAL_SESSION, "--fail-on-skill-drift"]).code).toBe(0);
    expect(run(["verify-cassettes", moved, "--session", REAL_SESSION]).code).toBe(0);
  });

  it("announces the override on stderr — it must never be silent about where it looked", () => {
    // A wrong override that silently pinned the wrong tree would manufacture false greens, which is
    // strictly worse than the honest exit 3 it replaces.
    const r = run(["replay", relocate(), "--session", REAL_SESSION]);
    expect(r.err).toMatch(/--session override in effect/);
    expect(r.err).toContain(REAL_SESSION);
  });

  it("a WRONG --session does not produce a false green", () => {
    // DISCRIMINATING: a relocated cassette is ALREADY non-zero, so `.not.toBe(0)` alone would pass even if
    // --session were parsed and thrown away. Pair it against a CORRECT override on the same cassette that
    // does exit 0, and assert the failure names the bogus session rather than any old error.
    const d = mkdtempSync(join(tmpdir(), "cwh-wrong-"));
    const bogus = join(d, "other.yaml");
    writeFileSync(bogus, "permission_mode: default\n"); // parses, mounts nothing
    const moved = relocate();
    const wrong = run(["replay", moved, "--session", bogus, "--fail-on-skill-drift"]);
    expect(wrong.code, "a session mounting nothing cannot verify the skill").not.toBe(0);
    expect(`${wrong.out}${wrong.err}`, "and it must say so, not fail for some unrelated reason").toMatch(/declares none|not resolvable/);
    expect(run(["replay", moved, "--session", REAL_SESSION, "--fail-on-skill-drift"]).code, "the control must pass").toBe(0);
  });

  it("session-SHAPE drift is computed against the OVERRIDDEN session, not the recorded path", () => {
    // The P1 an adversarial review found and this suite missed: sessionFingerprintDrift accepted an
    // override parameter its only caller never passed, so skill staleness used the override while session
    // shape still resolved the recorded cassette-relative path. That produced exit 0 "clean" on a session
    // whose shape would otherwise hard-fail. Both directions are pinned here.
    const skill = resolve("examples/skills/my-pdf-skill");
    const d = mkdtempSync(join(tmpdir(), "cwh-shape-"));
    const drifted = join(d, "drifted.yaml");
    writeFileSync(
      drifted,
      `permission_mode: default\nplugins:\n  local_plugins:\n    - ${skill}\negress:\n  extra_allow:\n    - evil.example.com\n`,
    );
    // Same skill tree (so skillHash matches) but a different session SHAPE — must NOT be reported clean.
    expect(run(["verify-cassettes", relocate(), "--session", drifted]).code, "shape drift must not be green").not.toBe(0);
    // Control: the real session has the recorded shape and stays clean, so the assertion above is not
    // just "any override fails".
    expect(run(["verify-cassettes", relocate(), "--session", REAL_SESSION]).code).toBe(0);
  });

  it("refuses --session on a cassette recording an inline scenario", () => {
    // It has no session file to override. Accepting it, announcing "override in effect", then ignoring it
    // produced three mutually contradictory lines.
    const c = JSON.parse(readFileSync(FIXTURE, "utf8"));
    c.scenario.session = "(inline)";
    const d = mkdtempSync(join(tmpdir(), "cwh-inline-"));
    const f = join(d, "inline.cassette.json");
    writeFileSync(f, JSON.stringify(c));
    for (const cmd of ["replay", "verify-cassettes"]) {
      const r = run([cmd, f, "--session", REAL_SESSION]);
      expect(r.code, `${cmd} should refuse`).not.toBe(0);
      expect(`${r.out}${r.err}`).toMatch(/inline scenario, which has no session file/);
    }
  });

  it("a session whose declared mounts do not resolve says SO, instead of 'declares none'", () => {
    // The most likely wrong-override shape: mounts are relative to the session's OWN directory, so a
    // correct session copied elsewhere declares real dirs that resolve to nothing. Reporting "this session
    // mounts none" for that states the opposite of the truth.
    const d = mkdtempSync(join(tmpdir(), "cwh-unresolved-"));
    const copied = join(d, "copied.yaml");
    writeFileSync(copied, "permission_mode: default\nplugins:\n  local_plugins:\n    - ../skills/my-pdf-skill\n");
    const r = run(["verify-cassettes", relocate(), "--session", copied]);
    expect(r.err, "the notice must not claim the session mounts nothing").toMatch(/declares 1 but none exist/);
    expect(`${r.out}${r.err}`, "and the finding must name the cause").toMatch(/declares 1 skill dir\(s\) and none exist/);
  });

  it("session-level staleness.hash_ignore is READ FROM the overriding session", () => {
    // This is the reason the override supplies a SESSION and not bare directories: `hash_ignore` is a
    // session-level field that is NOT persisted in the cassette (0 occurrences in the cassette schema), so
    // an override carrying only dirs would silently change the hash boundary and report false drift.
    //
    // DISCRIMINATING PAIR — an earlier version of this test used an ignore pattern that matched nothing,
    // which would have passed even if `hash_ignore` were dropped entirely. Both sessions below mount the
    // same tree; only the ignore differs, and it matches REAL files:
    const skill = resolve("examples/skills/my-pdf-skill");
    const d = mkdtempSync(join(tmpdir(), "cwh-ignore-"));
    const plain = join(d, "plain.yaml");
    const ignoring = join(d, "ignoring.yaml");
    const mounts = `permission_mode: default\nplugins:\n  local_plugins:\n    - ${skill}\n`;
    writeFileSync(plain, mounts);
    writeFileSync(ignoring, `${mounts}staleness:\n  hash_ignore:\n    - "**/SKILL.md"\n`);

    // Same mounts, no ignore → the live hash matches the recorded one.
    expect(run(["replay", relocate(), "--session", plain, "--fail-on-skill-drift"]).code, "plain override should verify fresh").toBe(0);
    // Same mounts, ignoring a file the recording DID hash → the boundary changed, so this must NOT be
    // green. If it were, `hash_ignore` was not read from the overriding session.
    expect(run(["replay", relocate(), "--session", ignoring, "--fail-on-skill-drift"]).code, "the ignore must move the hash").not.toBe(0);
  });
});

describe.skipIf(!CAN)("failure provenance reaches the operator", () => {
  it("an unresolvable session NAMES the path it looked for, and the remedy", () => {
    // Ship B carried a typed failure but nothing read it, so every cause still produced one
    // undifferentiated message. "Missing session file" and "unparseable YAML" point at completely
    // different fixes, and only the first is what a relocation looks like.
    const r = run(["replay", relocate(), "--fail-on-skill-drift"]);
    const all = `${r.out}${r.err}`;
    expect(all).toMatch(/no session file at .*sessions[/\\]default\.yaml/);
    expect(all, "a relocated cassette should be told about the escape hatch").toMatch(/--session <file>/);
  });

  it("names the DIRS the override resolved to, not just the file", () => {
    // "override in effect: <path>" alone would look right while resolving to nothing. The dirs are what
    // feed the hash, and they are what a wrong override gets wrong.
    const r = run(["replay", relocate(), "--session", REAL_SESSION]);
    expect(r.err).toMatch(/--session override in effect: .* -> .*my-pdf-skill/);
  });

  it("says so explicitly when an override mounts NO skill dirs", () => {
    const d = mkdtempSync(join(tmpdir(), "cwh-nodirs-"));
    const empty = join(d, "empty.yaml");
    writeFileSync(empty, "permission_mode: default\n");
    expect(run(["replay", relocate(), "--session", empty]).err).toMatch(/NO skill dirs/);
  });

  it("the skill-hash debug dump enumerates the OVERRIDDEN tree", () => {
    // The dump resolves its own file list. Without the override threaded it would enumerate the RECORDED
    // location — which under --session no longer exists — producing an empty or wrong list exactly when
    // someone is trying to find out which files drifted.
    const skill = resolve("examples/skills/my-pdf-skill");
    const d = mkdtempSync(join(tmpdir(), "cwh-dump-"));
    const ignoring = join(d, "ignoring.yaml");
    writeFileSync(
      ignoring,
      `permission_mode: default\nplugins:\n  local_plugins:\n    - ${skill}\nstaleness:\n  hash_ignore:\n    - "**/SKILL.md"\n`,
    );
    const r = spawnSync("node", [CLI, "replay", relocate(), "--session", ignoring, "--fail-on-skill-drift"], {
      encoding: "utf8",
      env: { ...process.env, COWORK_HARNESS_DEBUG_SKILLHASH: "1" },
    });
    const all = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    expect(all, "the mismatch should trigger the dump").toMatch(/skill-hash debug/);
    expect(all, "and it should list files from the overridden tree").toMatch(/plugin\.json/);
  });
});

describe.skipIf(!CAN)("--session refuses what it cannot mean", () => {
  it("is refused for a directory batch", () => {
    // Each cassette in a directory may have been recorded against a different source, so ONE session
    // cannot be right for all of them. Same reasoning as `record --out` and the `--assert-from --write`
    // guard: refuse rather than silently pin the wrong tree.
    for (const cmd of ["replay", "verify-cassettes"]) {
      const r = run([cmd, resolve("examples/replays"), "--session", REAL_SESSION]);
      expect(r.code, `${cmd} should refuse a batch`).not.toBe(0);
      expect(`${r.out}${r.err}`).toMatch(/not valid for a directory target/);
    }
  });

  it("refuses a directory TARGET even when it holds exactly one cassette", () => {
    // Keying on `files.length > 1` accepted a directory holding one cassette — benign until the day a
    // second one lands, at which point the same command silently changes meaning.
    const d = mkdtempSync(join(tmpdir(), "cwh-onedir-"));
    copyFileSync(FIXTURE, join(d, "only.cassette.json"));
    for (const cmd of ["replay", "verify-cassettes"]) {
      const r = run([cmd, d, "--session", REAL_SESSION]);
      expect(r.code, `${cmd} should refuse a directory target`).not.toBe(0);
      expect(`${r.out}${r.err}`).toMatch(/not valid for a directory target/);
    }
  });

  it("refuses a --session that exists but is not a regular file", () => {
    // A directory passed the existence gate and only surfaced later as an EISDIR parse error, while the
    // notice meanwhile announced the override as "in effect".
    for (const cmd of ["replay", "verify-cassettes"]) {
      const r = run([cmd, relocate(), "--session", resolve("examples/sessions")]);
      expect(r.code, `${cmd} should refuse a directory as --session`).not.toBe(0);
      expect(`${r.out}${r.err}`).toMatch(/not a session file/);
    }
  });

  it("refuses a session path that does not exist rather than falling back", () => {
    // Silently falling back to the recorded path would report "unverifiable" for a typo, sending the
    // operator to re-record when the real problem was a misspelt flag.
    for (const cmd of ["replay", "verify-cassettes"]) {
      const r = run([cmd, relocate(), "--session", "/no/such/session.yaml"]);
      // Exit 2 (usage), NOT merely non-zero: a relocated cassette already exits 3 under
      // verify-cassettes, so `.not.toBe(0)` there would pass for the very baseline this flag escapes.
      expect(r.code, `${cmd} should refuse a missing session as a USAGE error`).toBe(2);
      expect(`${r.out}${r.err}`).toMatch(/not a session file/);
    }
  });
});

describe.skipIf(!CAN)("failure kinds the provenance work claims to distinguish", () => {
  it("an UNPARSEABLE session reports the parse error, not 'missing'", () => {
    // The test file's own comment argues these "point at completely different fixes", but only the
    // not-found branch had a test — blanking the unreadable detail caused zero failures.
    const d = mkdtempSync(join(tmpdir(), "cwh-bad-"));
    const bad = join(d, "bad.yaml");
    writeFileSync(bad, "plugins: [unclosed\n");
    const all = (({ out, err }) => `${out}${err}`)(run(["verify-cassettes", relocate(), "--session", bad]));
    expect(all).toMatch(/could not be read or parsed/);
    expect(all, "must NOT be reported as a missing file").not.toMatch(/no session file at/);
  });

  it("the '--session' remedy hint is suppressed once an override was given", () => {
    // Telling an operator who just passed --session to pass --session is noise that reads as the flag
    // having been ignored. Making the hint unconditional caused zero failures.
    const withOverride = mkdtempSync(join(tmpdir(), "cwh-hint-"));
    const empty = join(withOverride, "empty.yaml");
    writeFileSync(empty, "permission_mode: default\n");
    const hinted = (({ out, err }) => `${out}${err}`)(run(["replay", relocate(), "--fail-on-skill-drift"]));
    const overridden = (({ out, err }) => `${out}${err}`)(run(["replay", relocate(), "--session", empty, "--fail-on-skill-drift"]));
    expect(hinted, "no override → offer the escape hatch").toMatch(/point at its session with --session/);
    expect(overridden, "override already given → do not repeat it back").not.toMatch(/point at its session with --session/);
  });
});

describe.skipIf(!CAN)("2.0.0 — unverifiable staleness fails the DEFAULT verdict (Ship E)", () => {
  it("a bare replay FAILS on a relocated cassette, where it used to warn and exit 0", () => {
    const r = run(["replay", relocate()]);
    expect(r.code, "no flags at all — this is the breaking change").not.toBe(0);
    expect(`${r.out}${r.err}`).toMatch(/skill staleness could not be verified/);
  });

  it("but an in-place cassette still passes a bare replay", () => {
    // The control. Without it the assertion above would be satisfied by breaking replay outright.
    expect(run(["replay", FIXTURE]).code).toBe(0);
  });

  it("and --session is the remedy, not a re-record", () => {
    expect(run(["replay", relocate(), "--session", REAL_SESSION]).code).toBe(0);
  });

  it("stays NARROW: content drift still needs --fail-on-skill-drift", () => {
    // `skill` / `shared-root` mean "we checked, and it changed" — a different claim from "could not
    // check", and deliberately still opt-in so the flag keeps its meaning. Same skill tree via an
    // override, with an ignore that moves the boundary: drift is real, but a bare replay must not fail
    // on it.
    const skill = resolve("examples/skills/my-pdf-skill");
    const d = mkdtempSync(join(tmpdir(), "cwh-narrow-"));
    const ignoring = join(d, "ignoring.yaml");
    writeFileSync(
      ignoring,
      `permission_mode: default\nplugins:\n  local_plugins:\n    - ${skill}\nstaleness:\n  hash_ignore:\n    - "**/SKILL.md"\n`,
    );
    const moved = relocate();
    expect(run(["replay", moved, "--session", ignoring]).code, "content drift alone must not fail a bare replay").toBe(0);
    expect(run(["replay", moved, "--session", ignoring, "--fail-on-skill-drift"]).code, "the flag still escalates it").not.toBe(0);
  });
});
