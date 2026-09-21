import { describe, it, expect } from "vitest";
import { matchesSkillId } from "../src/critique/skill-invocation.js";

// The selector is a validated single path segment by the time it reaches this module
// (`safePathSegment` in `resolveCritiquedSkillDir`), so there is no selector normalisation to test —
// an earlier version of this file pinned `./x`, `x/` and `skills/../x` forms that the CLI now refuses.

describe("matchesSkillId", () => {
  it("matches the bare name and the plugin-qualified form", () => {
    expect(matchesSkillId("deck-review", "deck-review")).toBe(true);
    expect(matchesSkillId("founder-skills:deck-review", "deck-review")).toBe(true);
    expect(matchesSkillId("founder-skills:deck-review", "deck-review", "founder-skills")).toBe(true);
  });

  it("does NOT match a different skill that merely contains the name", () => {
    expect(matchesSkillId("founder-skills:deck-review-lite", "deck-review")).toBe(false);
    expect(matchesSkillId("other:predeck-review", "deck-review")).toBe(false);
    expect(matchesSkillId("deck-review-lite", "deck-review")).toBe(false);
  });

  it("does NOT match a same-named skill from ANOTHER plugin when the graded plugin is known", () => {
    // Both `skill-creator:skill-creator` and `anthropic-skills:skill-creator` are installed on a
    // maintainer machine and both reach the inventory at hostloop/protocol. Without the qualifier check
    // a critique of one would be satisfied by the other having run.
    expect(matchesSkillId("anthropic-skills:skill-creator", "skill-creator", "skill-creator")).toBe(false);
    expect(matchesSkillId("skill-creator:skill-creator", "skill-creator", "skill-creator")).toBe(true);
  });

  it("accepts any qualifier only when the graded plugin is unknown", () => {
    expect(matchesSkillId("anthropic-skills:skill-creator", "skill-creator", undefined)).toBe(true);
  });

  it("does not match the un-attributed sentinels, even by exact text", () => {
    // These selectors are unreachable through the CLI (parentheses fail `safePathSegment`), so the
    // guard is tested at the function boundary with the one input that would otherwise match EXACTLY:
    // delete the SENTINELS check and `"(root)" === "(root)"` makes this green.
    expect(matchesSkillId("(root)", "(root)")).toBe(false);
    expect(matchesSkillId("(unknown)", "(unknown)")).toBe(false);
  });
});
