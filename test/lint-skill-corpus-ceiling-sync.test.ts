import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SKILL_CORPUS_CEILING } from "../src/critique/package-evidence.js";

// The Python linter re-declares the evidence ceiling because it cannot import TypeScript. Two copies of
// a number with nothing pinning them is how a warning threshold silently stops matching the thing it
// warns about — so the copy is asserted against the source of truth here.
describe("lint-skill corpus ceiling ↔ SKILL_CORPUS_CEILING", () => {
  const py = readFileSync(resolve(".claude/skills/cowork-harness/scripts/scenario.py"), "utf8");

  it("scenario.py declares the same ceiling the packager enforces", () => {
    const m = py.match(/^_EVIDENCE_CORPUS_CEILING\s*=\s*(\d+)\s*\*\s*1024\s*$/m);
    expect(m, "expected a `_EVIDENCE_CORPUS_CEILING = <n> * 1024` line in scenario.py").toBeTruthy();
    expect(Number(m![1]) * 1024).toBe(SKILL_CORPUS_CEILING);
  });
});
