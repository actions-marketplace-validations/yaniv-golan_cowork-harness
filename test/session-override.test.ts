import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, copyFileSync, writeFileSync } from "node:fs";
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
    const d = mkdtempSync(join(tmpdir(), "cwh-wrong-"));
    const bogus = join(d, "other.yaml");
    writeFileSync(bogus, "permission_mode: default\n"); // valid session, declares no skill dirs
    expect(run(["replay", relocate(), "--session", bogus, "--fail-on-skill-drift"]).code).not.toBe(0);
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

describe.skipIf(!CAN)("--session refuses what it cannot mean", () => {
  it("is refused for a directory batch", () => {
    // Each cassette in a directory may have been recorded against a different source, so ONE session
    // cannot be right for all of them. Same reasoning as `record --out` and the `--assert-from --write`
    // guard: refuse rather than silently pin the wrong tree.
    for (const cmd of ["replay", "verify-cassettes"]) {
      const r = run([cmd, resolve("examples/replays"), "--session", REAL_SESSION]);
      expect(r.code, `${cmd} should refuse a batch`).not.toBe(0);
      expect(`${r.out}${r.err}`).toMatch(/not valid for a directory batch/);
    }
  });

  it("refuses a session path that does not exist rather than falling back", () => {
    // Silently falling back to the recorded path would report "unverifiable" for a typo, sending the
    // operator to re-record when the real problem was a misspelt flag.
    for (const cmd of ["replay", "verify-cassettes"]) {
      const r = run([cmd, relocate(), "--session", "/no/such/session.yaml"]);
      expect(r.code, `${cmd} should refuse a missing session`).not.toBe(0);
      expect(`${r.out}${r.err}`).toMatch(/no such session file/);
    }
  });
});

describe("the flag is documented", () => {
  it("appears in both usage strings", async () => {
    const { REPLAY_USAGE, VERIFY_CASSETTES_USAGE } = await import("../src/run/cassette.js");
    // The usage-coverage guard already fails on an undocumented accepted flag; this pins the specific
    // regression by name, matching how that suite treats --best-effort-future-cassette.
    for (const usage of [REPLAY_USAGE, VERIFY_CASSETTES_USAGE]) expect(usage).toMatch(/--session <file>/);
  });
});
