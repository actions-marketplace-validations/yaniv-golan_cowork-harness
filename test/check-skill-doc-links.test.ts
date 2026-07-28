import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSkillDocLinks, findViolations } from "../scripts/check-skill-doc-links.js";

describe("findViolations", () => {
  it("flags a bare docs/*.md reference — the exact defect this guard exists to catch", () => {
    const v = findViolations([{ path: "SKILL.md", content: "See docs/critique.md for the flag table." }]);
    expect(v).toEqual([{ file: "SKILL.md", line: 1, target: "docs/critique.md" }]);
  });

  it("does not flag a bare permalink URL (the fix shape used for a YAML/Python comment)", () => {
    const v = findViolations([
      { path: "references/ci-recipe.md", content: "# see https://github.com/yaniv-golan/cowork-harness/blob/main/docs/maintenance.md" },
    ]);
    expect(v).toEqual([]);
  });

  it("does not flag a markdown link whose text repeats the bare path and whose target is the permalink", () => {
    const v = findViolations([
      {
        path: "SKILL.md",
        content:
          "the fuller map lives in [`docs/debugging.md`](https://github.com/yaniv-golan/cowork-harness/blob/main/docs/debugging.md).",
      },
    ]);
    expect(v).toEqual([]);
  });

  it("flags two bare references on the same line, independently", () => {
    const v = findViolations([{ path: "x.md", content: "see docs/boundary.md / docs/fidelity-gaps.md (repo-only)" }]);
    expect(v.map((x) => x.target)).toEqual(["docs/boundary.md", "docs/fidelity-gaps.md"]);
  });

  it("still flags a bare reference on a line that ALSO contains an unrelated permalink", () => {
    // Regression against a checker that strips ALL "docs/*.md" text once any permalink appears on the line.
    const v = findViolations([
      {
        path: "x.md",
        content: "linked: https://github.com/yaniv-golan/cowork-harness/blob/main/docs/scenario.md, but this one is bare: docs/session.md",
      },
    ]);
    expect(v).toEqual([{ file: "x.md", line: 1, target: "docs/session.md" }]);
  });

  it("reports 1-based line numbers across a multi-line file", () => {
    const v = findViolations([{ path: "x.md", content: "line one\nline two\nsee docs/cassette.md here\n" }]);
    expect(v).toEqual([{ file: "x.md", line: 3, target: "docs/cassette.md" }]);
  });
});

// Integration/mutation proof: drive the actual CLI-entry pipeline (git ls-files -> readFileSync ->
// findViolations) against a throwaway git repo, so the test proves the WIRED guard fails on a real
// violation — not just the inner pure function in isolation.
describe("checkSkillDocLinks (end-to-end against a scratch git repo)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "skill-doc-links-"));
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "test"], { cwd: dir });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeAndTrack(relPath: string, content: string): void {
    const abs = join(dir, relPath);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
    execFileSync("git", ["add", relPath], { cwd: dir });
  }

  it("FAILS on a fixture with a dangling docs/*.md reference (the mutation this guard must catch)", () => {
    writeAndTrack(".claude/skills/demo-skill/SKILL.md", "For the full flag table see docs/critique.md.\n");
    const r = checkSkillDocLinks(dir);
    expect(r.ok).toBe(false);
    expect(r.violations).toEqual([{ file: ".claude/skills/demo-skill/SKILL.md", line: 1, target: "docs/critique.md" }]);
    expect(r.errors[0]).toMatch(/demo-skill\/SKILL\.md:1:.*docs\/critique\.md.*dead for a plugin install/);
  });

  it("PASSES once the dangling reference is rewritten to a GitHub blob permalink", () => {
    writeAndTrack(
      ".claude/skills/demo-skill/SKILL.md",
      "For the full flag table see [docs/critique.md](https://github.com/yaniv-golan/cowork-harness/blob/main/docs/critique.md).\n",
    );
    const r = checkSkillDocLinks(dir);
    expect(r.ok).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it("PASSES on a repo with no docs/*.md mentions at all", () => {
    writeAndTrack(".claude/skills/demo-skill/SKILL.md", "Nothing to see here.\n");
    const r = checkSkillDocLinks(dir);
    expect(r.ok).toBe(true);
  });

  it("ignores an UNTRACKED file under .claude/skills — matches what a plugin install actually stages", () => {
    const abs = join(dir, ".claude/skills/demo-skill/SKILL.md");
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, "see docs/critique.md\n"); // written but never `git add`ed
    const r = checkSkillDocLinks(dir);
    expect(r.ok).toBe(true);
  });
});

// Regression proof: the guard must be green on the actual shipped skill payload in this repo — this is
// what task item 2 (rewriting the 25 real dead references) is verified against, and it re-fails the
// moment anyone reintroduces a bare docs/*.md pointer under .claude/skills/**.
describe("checkSkillDocLinks (real repo tree)", () => {
  it("is clean on the committed .claude/skills/** payload", () => {
    const r = checkSkillDocLinks();
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });
});
