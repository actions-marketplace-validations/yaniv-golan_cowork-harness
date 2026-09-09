import { describe, it, expect } from "vitest";
import { slashCommandSkillInvocation, observedSkillInvocation, hasUnattributableSkillCall } from "../src/critique/skill-invocation.js";

const SKILLS = [{ id: "founder-skills:deck-review" }, { id: "founder-skills:cap-table" }, { id: "deep-research" }];

describe("slashCommandSkillInvocation", () => {
  it("returns the id for a leading /plugin:skill that IS a staged skill", () => {
    expect(slashCommandSkillInvocation("/founder-skills:deck-review slides at https://x/", SKILLS)).toEqual({
      kind: "skill",
      id: "founder-skills:deck-review",
    });
  });

  it("rejects a slash command that is NOT a staged skill (a plugin command)", () => {
    // Verified real cases: founder-skills:feedback, creative-problem-solving:ideas.
    expect(slashCommandSkillInvocation("/founder-skills:feedback it broke", SKILLS)).toEqual({ kind: "none" });
  });

  it("ignores a slash that is not in leading position", () => {
    expect(slashCommandSkillInvocation("please run /founder-skills:deck-review", SKILLS)).toEqual({ kind: "none" });
  });

  it("does not treat an absolute path as a command", () => {
    expect(slashCommandSkillInvocation("/Users/yaniv/deck.pdf please review", SKILLS)).toEqual({ kind: "none" });
  });

  it("strips trailing sentence punctuation before matching", () => {
    expect(slashCommandSkillInvocation("/founder-skills:deck-review.", SKILLS)).toEqual({
      kind: "skill",
      id: "founder-skills:deck-review",
    });
  });

  it("is unobservable when the inventory is absent", () => {
    expect(slashCommandSkillInvocation("/founder-skills:deck-review x", undefined)).toEqual({ kind: "unobservable" });
  });

  it("is unobservable when the prompt is absent", () => {
    expect(slashCommandSkillInvocation(undefined, SKILLS)).toEqual({ kind: "unobservable" });
  });
});

describe("hasUnattributableSkillCall", () => {
  const top = '{"seq":13,"type":"tool_use","name":"Skill","toolUseId":"toolu_A","skillScope":"probe"}';
  const child = '{"seq":18,"type":"tool_use","name":"Skill","toolUseId":"toolu_B","parentToolUseId":"toolu_P"}';
  const other = '{"seq":19,"type":"tool_use","name":"Read","parentToolUseId":"toolu_P"}';

  it("finds a sub-agent-parented Skill call", () => {
    expect(hasUnattributableSkillCall([top, child, other].join("\n"))).toBe(true);
  });

  it("ignores a top-level Skill call (that one IS attributed)", () => {
    expect(hasUnattributableSkillCall([top, other].join("\n"))).toBe(false);
  });

  it("survives a torn final line", () => {
    expect(hasUnattributableSkillCall(top + '\n{"seq":20,"ty')).toBe(false);
  });

  it("is empty-safe", () => {
    expect(hasUnattributableSkillCall("")).toBe(false);
  });
});

describe("observedSkillInvocation", () => {
  const activity = (ids: string[]) => ids.map((skillId) => ({ skillId }));

  it("true when skillActivity names it", () => {
    expect(observedSkillInvocation("deck-review", activity(["founder-skills:deck-review"]), { kind: "none" }, false, false)).toBe(true);
  });

  it("true when a staged-skill slash command named it", () => {
    expect(
      observedSkillInvocation("deck-review", activity(["(root)"]), { kind: "skill", id: "founder-skills:deck-review" }, false, false),
    ).toBe(true);
  });

  it("false when both channels were observable and neither fired", () => {
    expect(observedSkillInvocation("deck-review", activity(["(root)"]), { kind: "none" }, false, false)).toBe(false);
  });

  it("undefined when the slash channel was unobservable", () => {
    expect(observedSkillInvocation("deck-review", activity(["(root)"]), { kind: "unobservable" }, false, false)).toBe(undefined);
  });

  it("undefined when skillActivity itself is absent", () => {
    expect(observedSkillInvocation("deck-review", undefined, { kind: "none" }, false, false)).toBe(undefined);
  });

  it("undefined — never true — when a same-named command shadows the skill", () => {
    expect(observedSkillInvocation("bootstrap", activity(["(root)"]), { kind: "skill", id: "vercel:bootstrap" }, true, false)).toBe(
      undefined,
    );
  });

  it("undefined, not false, when an unattributable Skill call exists", () => {
    expect(observedSkillInvocation("deck-review", activity(["(root)"]), { kind: "none" }, false, true)).toBe(undefined);
  });

  it("still true when THIS skill was identified, sub-agent noise notwithstanding", () => {
    expect(observedSkillInvocation("deck-review", activity(["founder-skills:deck-review"]), { kind: "none" }, false, true)).toBe(true);
  });
});

describe("the runs that motivated this (regression, values verbatim from result.graded.json)", () => {
  it("RUN1's slash-command prompt reads as INVOKED", () => {
    const r = slashCommandSkillInvocation("/founder-skills:deck-review slides at https://zeroport-deck.vercel.app/", SKILLS);
    expect(observedSkillInvocation("deck-review", [{ skillId: "(root)" }], r, false, false)).toBe(true);
  });

  it("RUN2's prose prompt still reads as NOT invoked", () => {
    const r = slashCommandSkillInvocation("You must use the founder-skills deck-review skill. Review the slides.", SKILLS);
    expect(observedSkillInvocation("deck-review", [{ skillId: "(root)" }], r, false, false)).toBe(false);
  });
});
