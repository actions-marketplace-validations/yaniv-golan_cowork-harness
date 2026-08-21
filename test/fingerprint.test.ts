import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, isAbsolute, dirname } from "node:path";
import { buildFingerprint } from "../src/run/cassette.js";

/** Build a session dir with a relative-path local skill, returns the session-file path. */
function sessionWithSkill(): { sessionPath: string; skillFile: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "cwh-fp-"));
  const skillDir = join(root, "myskill");
  mkdirSync(skillDir, { recursive: true });
  const skillFile = join(skillDir, "SKILL.md");
  writeFileSync(skillFile, "# myskill\noriginal content\n");
  const sessionPath = join(root, "session.yaml");
  // Relative skill path — must resolve against the SESSION-FILE dir, not cwd.
  writeFileSync(sessionPath, "skills:\n  local:\n    - ./myskill\n");
  return { sessionPath, skillFile, root };
}

describe("buildFingerprint skillHash", () => {
  it("computes a non-empty skillHash for a file-based session with a local skill dir", () => {
    const { sessionPath } = sessionWithSkill();
    const fp = buildFingerprint(sessionPath, "1.0.0");
    expect(fp.skillHash).toBeDefined();
    expect(fp.skillHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes the skillHash when a skill file's CONTENT changes", () => {
    const { sessionPath, skillFile } = sessionWithSkill();
    const before = buildFingerprint(sessionPath, "1.0.0").skillHash;
    writeFileSync(skillFile, "# myskill\nEDITED content\n");
    const after = buildFingerprint(sessionPath, "1.0.0").skillHash;
    expect(after).not.toBe(before);
  });

  it("changes the skillHash when a skill file MOVES to a subdir (relative path, not basename)", () => {
    const { sessionPath, root } = sessionWithSkill();
    const skillDir = join(root, "myskill");
    writeFileSync(join(skillDir, "config.json"), '{"k":1}');
    const before = buildFingerprint(sessionPath, "1.0.0").skillHash;
    // Move config.json into a subdir with IDENTICAL content + basename.
    rmSync(join(skillDir, "config.json"));
    mkdirSync(join(skillDir, "sub"), { recursive: true });
    writeFileSync(join(skillDir, "sub", "config.json"), '{"k":1}');
    const after = buildFingerprint(sessionPath, "1.0.0").skillHash;
    expect(after).not.toBe(before);
  });

  it("writes skillSources RELATIVE, never absolute host paths", () => {
    const { sessionPath } = sessionWithSkill();
    const fp = buildFingerprint(sessionPath, "1.0.0");
    expect(fp.skillSources).toBeDefined();
    expect(fp.skillSources!.length).toBeGreaterThan(0);
    for (const s of fp.skillSources!) expect(isAbsolute(s)).toBe(false);
  });

  it("anchors skillSources to the SESSION-FILE dir, not the cassette dir", () => {
    // "Relative" alone does not say relative to WHAT, and the difference is load-bearing: `session:` and
    // `scenarioSource` are stored relative to the CASSETTE dir, while `skillSources` is relative to the
    // SESSION-FILE dir. Nothing pinned that, and the ambiguity has real cost — a wrong version of the
    // sentence shipped into five docs at once, and it was then re-derived wrongly twice more in one day,
    // including by someone who had just corrected it. Prose everyone has read is not a guard; this is.
    const { sessionPath, root } = sessionWithSkill();
    // A cassette dir deliberately DIFFERENT from the session dir, so the two anchors cannot coincide.
    const cassetteDir = mkdtempSync(join(tmpdir(), "cwh-cass-"));
    const fp = buildFingerprint(sessionPath, "1.0.0", cassetteDir);
    const rel = fp.skillSources![0];

    // Resolving against the SESSION dir finds the real tree...
    expect(existsSync(join(dirname(sessionPath), rel)), `${rel} must resolve from the session dir`).toBe(true);
    // ...and resolving against the CASSETTE dir does not. If this ever passes, the anchor has changed and
    // every doc sentence describing the resolution chain is wrong.
    expect(existsSync(join(cassetteDir, rel)), `${rel} must NOT resolve from the cassette dir`).toBe(false);
    expect(join(dirname(sessionPath), rel)).toBe(join(root, "myskill"));
  });
});
