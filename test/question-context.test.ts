import { describe, it, expect } from "vitest";
import { evaluate, gateVisibleText, type AssertContext } from "../src/assert.js";
import { QUESTION_GATE_KEYS } from "../src/run/cassette.js";
import { assertContradiction } from "../src/run/execute.js";
import { ScenarioObject, type Assertion } from "../src/types.js";

// The defect this key exists for, measured on a paid consumer run: a skill's producer appended a
// labelled sentence to the gate payload so the founder would be told the deck contradicted itself.
// The model put that sentence in the PROCEED OPTION'S `description`. `question_asked` reads the
// question text; `question_options` compares labels. Both missed it, the lane redded, and the
// conclusion "the founder was never told" was committed and later retracted — the founder HAD been
// told, in a field no assert key could read.

const gate = (question: string, options: { label: string; description?: string }[]) => ({ question, options });

function ctx(over: Partial<AssertContext> = {}): AssertContext {
  return {
    transcript: "",
    toolsCalled: new Set<string>(),
    subagentTools: new Set<string>(),
    filesRead: [],
    initTools: [],
    workRoot: "/nonexistent",
    userVisiblePrefixes: ["outputs"],
    readonlyFolderRoots: [],
    outputsDeletes: [],
    questions: [],
    gateOptions: [],
    hostPathLeaked: false,
    selfHealRan: false,
    subagents: [],
    gateDeliveries: [],
    toolResultTexts: [],
    result: "success",
    ...over,
  } as unknown as AssertContext;
}

const run = (a: Assertion, c: AssertContext) => evaluate([a], c)[0];

// The real payload from ~/.cowork-harness/runs/deck-review-stage-disagreement/local_8cw0d4f4tg,
// events.jsonl:204 — the sentence lives ONLY in options[0].description.
const REAL = gate("Does this stage detection look right?", [
  {
    label: "Looks right",
    description:
      "Detected stage: Pre-seed (high confidence). Key evidence: no revenue to date, 3 non-paying design partners. (The deck states: Seed. This review reads it as Pre-seed.)",
  },
  { label: "Different stage", description: "I want to choose the stage myself" },
  { label: "Not sure — proceed anyway", description: "Proceed with pre-seed at lower confidence" },
]);
const SENTENCE = "The deck states: Seed\\. This review reads it as Pre-seed\\.";

describe("question_context — everything a gate put in front of the user", () => {
  // THE regression, as a PAIR. A one-sided pass would also be produced by a key that merely matched the
  // question text; the second half is what proves the description is being read.
  it("matches text that lives ONLY in an option description, where question_asked cannot see it", () => {
    const c = ctx({ gateOptions: [REAL], questions: [REAL.question] });
    expect(run({ question_context: { matches: SENTENCE } }, c).pass).toBe(true);
    expect(run({ question_asked: SENTENCE }, c).pass).toBe(false);
  });

  it("matches a question label and an option label too — the payload is the union, not just descriptions", () => {
    const c = ctx({ gateOptions: [REAL] });
    expect(run({ question_context: { matches: "stage detection look right" } }, c).pass).toBe(true);
    expect(run({ question_context: { matches: "Different stage" } }, c).pass).toBe(true);
  });

  // Deliberately UNLIKE question_options, which refuses multi-gate runs without a selector. The
  // motivating fixture fires 5 sub-questions across 2 gates; mirroring that refusal would have redded
  // the exact run this key exists to green.
  it("does NOT refuse an unselected multi-gate run as ambiguous", () => {
    const many = [gate("Company name?", [{ label: "Northwind" }]), REAL];
    const r = run({ question_context: { matches: SENTENCE } }, ctx({ gateOptions: many }));
    expect(r.pass).toBe(true);
  });

  it("when_question narrows, and a selector matching no gate FAILS rather than searching the rest", () => {
    const many = [gate("Company name?", [{ label: "Northwind", description: SENTENCE.replace(/\\/g, "") }]), REAL];
    expect(run({ question_context: { when_question: "stage detection", matches: SENTENCE } }, ctx({ gateOptions: many })).pass).toBe(true);
    const miss = run({ question_context: { when_question: "no such gate", matches: SENTENCE } }, ctx({ gateOptions: many }));
    expect(miss.pass).toBe(false);
    expect(miss.message).toMatch(/no question matching/);
  });

  it("FAILS when the text was never shown, and names the gates it searched", () => {
    const r = run({ question_context: { matches: "never shown to anyone" } }, ctx({ gateOptions: [REAL] }));
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/Does this stage detection look right\?/);
  });

  // Fail CLOSED. An absent or partial gate payload must never satisfy a key whose whole job is to prove
  // what a person was shown.
  it("fails evidence-unavailable when gate evidence is missing or unreadable, never vacuously", () => {
    for (const c of [ctx({ gateOptions: undefined }), ctx({ gateOptions: [], gateOptionsMissing: true })]) {
      const r = run({ question_context: { matches: SENTENCE } }, c);
      expect(r.pass).toBe(false);
      expect(r.message).toMatch(/evidence unavailable/);
    }
  });

  it("zero gates recorded FAILS — it is not 'nothing to contradict'", () => {
    const r = run({ question_context: { matches: SENTENCE } }, ctx({ gateOptions: [] }));
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/no question was asked/);
  });

  it("reports a bad regex instead of silently never matching", () => {
    const r = run({ question_context: { matches: "([unclosed" } }, ctx({ gateOptions: [REAL] }));
    expect(r.pass).toBe(false);
    expect(r.message).toMatch(/bad regex/);
  });
});

describe("gateVisibleText — the evidence, and what it deliberately excludes", () => {
  it("joins question, labels and descriptions with newlines so a regex cannot straddle two fields", () => {
    const t = gateVisibleText(gate("Q?", [{ label: "A", description: "d1" }, { label: "B" }]));
    expect(t).toBe("Q?\nA\nd1\nB");
    // "A d1" was never contiguous on screen; a space-join would have made this match.
    expect(/A d1/.test(t)).toBe(false);
  });
});

describe("question_context is wired into the gate-key surface", () => {
  it("is replay-checkable with controlOut (QUESTION_GATE_KEYS)", () => {
    expect(QUESTION_GATE_KEYS).toContain("question_context");
  });

  // A gate must have FIRED for this key to mean anything, so it contradicts a zero-gate declaration —
  // and must be refused before the spend, exactly like question_asked/question_options.
  it("contradicts questions_count_max: 0, refused at load", () => {
    const s = ScenarioObject.parse({
      name: "x",
      prompt: "p",
      assert: [{ questions_count_max: 0 }, { question_context: { matches: "anything" } }],
    });
    expect(assertContradiction(s)).toMatch(/question_context/);
  });
});
