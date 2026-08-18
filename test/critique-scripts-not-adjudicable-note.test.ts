import { describe, it, expect } from "vitest";
import { buildTextReport } from "../src/critique/command.js";

// `scripts/` is outside the evaluator's corpus BY DESIGN — it grades authored guidance, not
// implementation (docs/critique.md). The design is right; the VERDICT WORDING was not. A consumer read
// "not adjudicable" on a claim about their own `gate_state.py` and treated it as unproven. It was a
// verified product bug; the evaluator had simply never been shown the file. This note makes the two
// readings distinguishable without touching the corpus boundary.

const item = (idea: string, classification = "not-adjudicable") => ({
  source: "self-report",
  classification,
  idea,
  recommendedAction: "none",
  evidence: "",
});

const state = (items: unknown[]) =>
  ({
    skillFolder: "./skill",
    prompt: "p",
    sessionId: "s",
    outDir: "/tmp/o",
    taskResult: "success",
    items,
  }) as unknown as Parameters<typeof buildTextReport>[0];

describe("a scripts/-grounded not-adjudicable explains itself", () => {
  it("adds the note, names the boundary, and names the documented remedy", () => {
    const out = buildTextReport(state([item("gate_state.py rejects any summary containing the word 'growth'")]));
    expect(out).toMatch(/could not SEE the code, NOT that the claim is false/);
    expect(out).toMatch(/OUTSIDE the evaluator's corpus by design/);
    // The remedy the docs already prescribe — not just a statement of the gap.
    expect(out).toMatch(/state it in SKILL\.md or a references\/ file/);
  });

  it("matches a scripts/ path as well as a bare source filename", () => {
    expect(buildTextReport(state([item("the check in scripts/ledger.py is wrong")]))).toMatch(/could not SEE the code/);
    expect(buildTextReport(state([item("compose_report.py drops the header")]))).toMatch(/could not SEE the code/);
  });

  it("stays silent when no not-adjudicable item concerns a script", () => {
    const out = buildTextReport(state([item("SKILL.md step 3 is ambiguous about ordering")]));
    expect(out).not.toMatch(/could not SEE the code/);
  });

  // Scope: this explains a verdict that was already issued. It must not appear next to a finding the
  // evaluator DID adjudicate — that would read as an excuse for a decided call.
  it("does not fire for a script claim the evaluator actually decided", () => {
    const out = buildTextReport(state([item("scripts/ledger.py drops dates", "grounded-and-actionable")]));
    expect(out).not.toMatch(/could not SEE the code/);
  });

  it("counts the items it is speaking for", () => {
    const out = buildTextReport(state([item("scripts/a.py x"), item("b.py y"), item("SKILL.md z")]));
    expect(out).toMatch(/note: 2 of these reference/);
  });
});
