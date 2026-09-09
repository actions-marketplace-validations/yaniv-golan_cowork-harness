import { describe, it, expect } from "vitest";
import { matchesSkillId, normalizeSkillSelector } from "../src/critique/skill-invocation.js";

describe("normalizeSkillSelector", () => {
  it("reduces every selector form resolveCritiquedSkillDir accepts to the bare name", () => {
    for (const raw of ["deck-review", "deck-review/", "./deck-review", "skills/../deck-review"])
      expect(normalizeSkillSelector(raw)).toBe("deck-review");
  });

  it("leaves a plugin-qualified id alone (the colon is not a separator)", () => {
    expect(normalizeSkillSelector("founder-skills:deck-review")).toBe("founder-skills:deck-review");
  });
});

describe("matchesSkillId", () => {
  it("matches the bare name and the plugin-qualified form", () => {
    expect(matchesSkillId("deck-review", "deck-review")).toBe(true);
    expect(matchesSkillId("founder-skills:deck-review", "deck-review")).toBe(true);
    expect(matchesSkillId("founder-skills:deck-review", "founder-skills:deck-review")).toBe(true);
  });

  it("does NOT match a different skill that merely contains the name", () => {
    expect(matchesSkillId("founder-skills:deck-review-lite", "deck-review")).toBe(false);
    expect(matchesSkillId("other:predeck-review", "deck-review")).toBe(false);
  });

  it("does not match the un-attributed sentinels", () => {
    expect(matchesSkillId("(root)", "root")).toBe(false);
    expect(matchesSkillId("(unknown)", "unknown")).toBe(false);
  });
});
