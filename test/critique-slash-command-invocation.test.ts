import { describe, it, expect } from "vitest";
import { slashCommandSkillInvocation, observedSkillInvocation, subagentSkillCalls } from "../src/critique/skill-invocation.js";

const SKILLS = [{ id: "founder-skills:deck-review" }, { id: "founder-skills:cap-table" }, { id: "deep-research" }];

// The slash rule is the BINARY's, measured: six prompts through the real host agent (2.1.278) with
// `ANTHROPIC_BASE_URL` pointed at a closed port — the expansion happens before any API call, so the
// persisted session transcript shows exactly what the binary did with each prompt, at $0. The table
// below IS the acceptance test; an earlier version of this file pinned the opposite of rows 3-5.
describe("slashCommandSkillInvocation — the binary's rule", () => {
  it("row 1: `/plugin:skill <args>` expands — the id", () => {
    expect(slashCommandSkillInvocation("/founder-skills:deck-review the deck", SKILLS)).toEqual({
      kind: "skill",
      id: "founder-skills:deck-review",
    });
  });

  it("row 2: `/plugin:skill` alone expands", () => {
    expect(slashCommandSkillInvocation("/founder-skills:deck-review", SKILLS)).toEqual({ kind: "skill", id: "founder-skills:deck-review" });
  });

  it("row 3: trailing `.` is part of the token — the binary sends `/plugin:skill.` as plain text", () => {
    expect(slashCommandSkillInvocation("/founder-skills:deck-review. the deck", SKILLS)).toEqual({ kind: "none" });
  });

  it("row 4: trailing `,` likewise", () => {
    expect(slashCommandSkillInvocation("/founder-skills:deck-review, the deck", SKILLS)).toEqual({ kind: "none" });
  });

  it("row 5: leading whitespace is NOT trimmed — the slash must be the first character", () => {
    expect(slashCommandSkillInvocation("\n  /founder-skills:deck-review the deck", SKILLS)).toEqual({ kind: "none" });
    expect(slashCommandSkillInvocation(" /founder-skills:deck-review", SKILLS)).toEqual({ kind: "none" });
  });

  it("row 6: a BARE name resolves to the one staged plugin skill that answers to it", () => {
    // The inventory spells every plugin skill qualified; the binary resolved `/deck-review` to
    // `founder-skills:deck-review` anyway. Matching only the exact id reported this run as NOT invoked.
    expect(slashCommandSkillInvocation("/deck-review the deck", SKILLS)).toEqual({ kind: "skill", id: "founder-skills:deck-review" });
  });

  it("a bare name that MORE THAN ONE staged skill answers to is unobservable, never none", () => {
    const two = [...SKILLS, { id: "other-plugin:deck-review" }];
    expect(slashCommandSkillInvocation("/deck-review the deck", two)).toEqual({ kind: "unobservable" });
  });

  it("a bare name that is itself a staged (standalone) skill id matches exactly", () => {
    expect(slashCommandSkillInvocation("/deep-research x", SKILLS)).toEqual({ kind: "skill", id: "deep-research" });
  });

  it("rejects a slash command that is NOT a staged skill (a plugin command)", () => {
    // Verified real cases: founder-skills:feedback, creative-problem-solving:ideas.
    expect(slashCommandSkillInvocation("/founder-skills:feedback it broke", SKILLS)).toEqual({ kind: "none" });
  });

  it("ignores a slash that is not in leading position", () => {
    expect(slashCommandSkillInvocation("please run /founder-skills:deck-review", SKILLS)).toEqual({ kind: "none" });
  });

  it("does not treat an absolute path as a command, even one whose first segment is a skill name", () => {
    expect(slashCommandSkillInvocation("/Users/yaniv/deck.pdf please review", SKILLS)).toEqual({ kind: "none" });
    // The token is `deep-research/notes.md`, not `deep-research`: path logic, not inventory luck.
    expect(slashCommandSkillInvocation("/deep-research/notes.md please review", SKILLS)).toEqual({ kind: "none" });
  });

  it("is unobservable when the inventory is absent", () => {
    expect(slashCommandSkillInvocation("/founder-skills:deck-review x", undefined)).toEqual({ kind: "unobservable" });
  });

  it("is unobservable when the prompt is absent", () => {
    expect(slashCommandSkillInvocation(undefined, SKILLS)).toEqual({ kind: "unobservable" });
  });
});

describe("subagentSkillCalls — the sub-agent channel, read from events.jsonl", () => {
  // Shapes verbatim from a real run (`skill-subagent-research-probe/local_iiwvy13syr/events.jsonl`).
  const frame = (parent: string | null, blocks: unknown[]) =>
    JSON.stringify({ type: "assistant", parent_tool_use_id: parent, message: { content: blocks } });
  const skill = (name: string) => ({ type: "tool_use", name: "Skill", id: "toolu_X", input: { skill: name } });

  it("names the skill a sub-agent invoked", () => {
    const lines = [frame(null, [skill("top-level:one")]), frame("toolu_P", [skill("subagent-research-probe:subagent-research-probe")])];
    expect(subagentSkillCalls(lines.join("\n"))).toEqual(["subagent-research-probe:subagent-research-probe"]);
  });

  it("ignores the main agent's own calls (parent_tool_use_id null) — those are in skillActivity already", () => {
    expect(subagentSkillCalls(frame(null, [skill("x:y")]))).toEqual([]);
  });

  it("ignores non-Skill tool calls inside a sub-agent", () => {
    expect(subagentSkillCalls(frame("toolu_P", [{ type: "tool_use", name: "Read", input: { file_path: "/x" } }]))).toEqual([]);
  });

  it("is undefined — cannot tell — when a parented Skill call carries no string skill name", () => {
    expect(subagentSkillCalls(frame("toolu_P", [{ type: "tool_use", name: "Skill", input: {} }]))).toBe(undefined);
  });

  it("survives a torn final line and is empty-safe", () => {
    expect(subagentSkillCalls(frame("toolu_P", [skill("a:b")]) + '\n{"type":"assis')).toEqual(["a:b"]);
    expect(subagentSkillCalls("")).toEqual([]);
  });
});

describe("observedSkillInvocation", () => {
  const activity = (ids: string[]) => ids.map((skillId) => ({ skillId }));
  const NONE = { kind: "none" } as const;
  const P = "founder-skills";

  it("true when skillActivity names it", () => {
    expect(observedSkillInvocation("deck-review", P, activity(["founder-skills:deck-review"]), [], NONE, false)).toBe(true);
  });

  it("true when a staged-skill slash command named it", () => {
    expect(
      observedSkillInvocation("deck-review", P, activity(["(root)"]), [], { kind: "skill", id: "founder-skills:deck-review" }, false),
    ).toBe(true);
  });

  it("true when a SUB-AGENT's Skill call named it", () => {
    expect(observedSkillInvocation("deck-review", P, activity(["(root)"]), ["founder-skills:deck-review"], NONE, false)).toBe(true);
  });

  it("false when every channel was observable and none fired", () => {
    expect(observedSkillInvocation("deck-review", P, activity(["(root)"]), ["other:thing"], NONE, false)).toBe(false);
  });

  it("undefined when the slash channel was unobservable", () => {
    expect(observedSkillInvocation("deck-review", P, activity(["(root)"]), [], { kind: "unobservable" }, false)).toBe(undefined);
  });

  it("undefined when skillActivity itself is absent", () => {
    expect(observedSkillInvocation("deck-review", P, undefined, [], NONE, false)).toBe(undefined);
  });

  it("undefined when the sub-agent channel could not be read", () => {
    expect(observedSkillInvocation("deck-review", P, activity(["(root)"]), undefined, NONE, false)).toBe(undefined);
  });

  it("undefined — never true — when a same-named command shadows the skill, on the SLASH channel", () => {
    expect(observedSkillInvocation("bootstrap", "vercel", activity(["(root)"]), [], { kind: "skill", id: "vercel:bootstrap" }, true)).toBe(
      undefined,
    );
  });

  it("undefined — never true — when a same-named command shadows the skill, on the TOOL channel too", () => {
    // The Skill tool launches plugin commands through the same registry (`Skill{skill:"creative-problem-solving:ideas"}`
    // is a command, measured 24/24), so a Skill call naming `vercel:bootstrap` is as undecidable as the slash token.
    expect(observedSkillInvocation("bootstrap", "vercel", activity(["vercel:bootstrap"]), [], NONE, true)).toBe(undefined);
  });

  it("undefined — never true — when a same-named command shadows the skill, on the SUB-AGENT channel too", () => {
    expect(observedSkillInvocation("bootstrap", "vercel", activity(["(root)"]), ["vercel:bootstrap"], NONE, true)).toBe(undefined);
  });

  it("false (not undefined) under a shadow when NO channel named the skill at all", () => {
    // The shadow withholds a POSITIVE; it does not manufacture an unknown where every channel was read
    // and none fired. The text report prints the shadow NOTE only beside an absent verdict.
    expect(observedSkillInvocation("bootstrap", "vercel", activity(["(root)"]), [], NONE, true)).toBe(false);
  });

  it("undefined, not false, when a top-level Skill call's id could not be read (the `(unknown)` sentinel)", () => {
    expect(observedSkillInvocation("deck-review", P, activity(["(unknown)"]), [], NONE, false)).toBe(undefined);
  });

  it("false, not true, when the only match is a same-named skill from another plugin", () => {
    expect(observedSkillInvocation("deck-review", P, activity(["other-plugin:deck-review"]), [], NONE, false)).toBe(false);
  });
});

describe("the runs that motivated this (regression, values verbatim from result.graded.json)", () => {
  it("RUN1's slash-command prompt reads as INVOKED", () => {
    const r = slashCommandSkillInvocation("/founder-skills:deck-review slides at https://zeroport-deck.vercel.app/", SKILLS);
    expect(observedSkillInvocation("deck-review", "founder-skills", [{ skillId: "(root)" }], [], r, false)).toBe(true);
  });

  it("RUN1's bare-name twin reads as INVOKED too", () => {
    const r = slashCommandSkillInvocation("/deck-review slides at https://zeroport-deck.vercel.app/", SKILLS);
    expect(observedSkillInvocation("deck-review", "founder-skills", [{ skillId: "(root)" }], [], r, false)).toBe(true);
  });

  it("RUN2's prose prompt still reads as NOT invoked", () => {
    const r = slashCommandSkillInvocation("You must use the founder-skills deck-review skill. Review the slides.", SKILLS);
    expect(observedSkillInvocation("deck-review", "founder-skills", [{ skillId: "(root)" }], [], r, false)).toBe(false);
  });
});
