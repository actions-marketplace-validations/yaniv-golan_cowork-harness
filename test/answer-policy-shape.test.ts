// T-D3 — a malformed `--answer-policy` document must fail LOUD, naming what is wrong.
//
// The loader read `Array.isArray(parsed) ? parsed : (parsed?.answers ?? [])`. A document keyed `answer:`
// instead of `answers:` therefore produced `undefined ?? []` → `[]`, which passes the `Array.isArray`
// check and validates as ZERO RULES. The function's own doc comment promises the opposite: "Fails LOUD on
// a missing / unparseable / non-list file — a malformed policy must NOT validate as '0 rules'".
//
// Why the severity is not "it exits 0": on `decide` the run already ends non-zero, because a zero-rule
// policy reaches "no rule matched" downstream. The real cost is on `run`/`record --answer-policy`, where
// zero rules means the agent SPENDS TOKENS and only then discovers the gate is unanswered. The user is
// told "no rule matched" — a downstream symptom — instead of "your policy file has no `answers` key".

import { describe, it, expect } from "vitest";
import { parseAnswerPolicyDoc } from "../src/answer-policy.js";

const ok = (r: ReturnType<typeof parseAnswerPolicyDoc>) => ("rules" in r ? r.rules : undefined);
const err = (r: ReturnType<typeof parseAnswerPolicyDoc>) => ("error" in r ? r.error : undefined);

describe("T-D3 · --answer-policy document shape", () => {
  const rule = { when_question: ".*", choose: "1" };

  it("accepts a bare list", () => {
    expect(ok(parseAnswerPolicyDoc([rule]))?.length).toBe(1);
  });

  it("accepts an {answers: [...]} document", () => {
    expect(ok(parseAnswerPolicyDoc({ answers: [rule] }))?.length).toBe(1);
  });

  it("REJECTS the singular-key typo instead of yielding zero rules", () => {
    // The whole point: `answer:` is one character from `answers:` and used to validate as an empty policy.
    const r = parseAnswerPolicyDoc({ answer: [rule] });
    expect(err(r), "a policy keyed `answer:` validated silently as zero rules").toBeDefined();
    // The message must name the key the user ACTUALLY typed — they need to see their own typo, not be
    // told what the correct key would have been.
    expect(err(r)).toContain("answer");
  });

  it("REJECTS a mapping with no answers key at all", () => {
    const r = parseAnswerPolicyDoc({ rules: [rule] });
    expect(err(r), "a mapping with no `answers` key validated as zero rules").toBeDefined();
    expect(err(r)).toContain("rules");
  });

  it("REJECTS an inherited (non-own) answers property", () => {
    // `?.answers` walks the prototype chain; an own-property check does not. Guards the fix's mechanism,
    // not just its happy path.
    const proto = { answers: [rule] };
    const doc = Object.create(proto) as object;
    expect(err(parseAnswerPolicyDoc(doc)), "an inherited `answers` was accepted as if authored").toBeDefined();
  });

  it("REJECTS scalars and null", () => {
    for (const bad of [null, 42, "answers", true]) {
      expect(err(parseAnswerPolicyDoc(bad)), `${JSON.stringify(bad)} was accepted`).toBeDefined();
    }
  });

  it("REJECTS a non-array answers value", () => {
    expect(err(parseAnswerPolicyDoc({ answers: { when_question: ".*" } }))).toBeDefined();
  });

  it("an empty list is legal — it is explicit, not a typo", () => {
    // Distinguish "the author wrote no rules" from "the author's key was wrong". Only the second is an
    // error; conflating them would make the fix reject a legitimate empty policy.
    expect(ok(parseAnswerPolicyDoc([]))).toEqual([]);
    expect(ok(parseAnswerPolicyDoc({ answers: [] }))).toEqual([]);
  });

  it("still rejects a malformed RULE inside a well-shaped document", () => {
    const r = parseAnswerPolicyDoc([{ when_question: 42 }]);
    expect(err(r), "a rule with a wrong field type was accepted").toBeDefined();
    expect(err(r)).toMatch(/rule #1/);
  });
});
