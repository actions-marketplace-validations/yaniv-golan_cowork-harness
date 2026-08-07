import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gateAssertContradiction } from "../src/run/execute.js";
import type { Scenario } from "../src/types.js";

// Cross-language drift tripwire (the scenario-lint-gate-id.test.ts pattern). The SAME defect is reported
// twice, in two languages that cannot share a string: `lint` reports `gate-assert-contradiction` from
// offline Python, and `run`/`skill`/`record` refuse it from TypeScript. The plan for this feature asked
// for "the same text" in both; that is not literally achievable, so this pins what must not diverge —
// the trigger set, and the claim each message makes.
//
// Compares EMITTED messages, not source text. A source scan cannot see a phrase the Python side wraps
// across two string literals, so it would report drift that isn't there (it did, on the first draft) —
// and, worse, would keep passing if the emitted message changed while the source fragments didn't.

const SCRIPT = resolve(".claude/skills/cowork-harness/scripts/scenario.py");
const py = process.env.PYTHON ?? "python3";
const havePython = spawnSync(py, ["--version"], { stdio: "ignore" }).status === 0;
if (!havePython) {
  // eslint-disable-next-line no-console
  console.warn("python3 not found — gate-contradiction message-sync tests skipped");
}

type Finding = { severity: string; rule: string; message: string; fix: string };

/** Lint a scenario body and return the `gate-assert-contradiction` finding, if any. */
function lintContradiction(assertBlock: string): Finding | undefined {
  const dir = mkdtempSync(join(tmpdir(), "cwh-gcms-"));
  const file = join(dir, "sc.yaml");
  writeFileSync(file, `name: t\nbaseline: latest\nsession: (inline)\nfidelity: container\nprompt: hi\n${assertBlock}`, "utf8");
  const r = spawnSync(py, [SCRIPT, "lint", "--json", file], { encoding: "utf8" });
  const findings: Finding[] = JSON.parse(r.stdout || "[]");
  return findings.find((f) => f.rule === "gate-assert-contradiction");
}

const scenario = (assert: unknown[]) => ({ name: "t", prompt: "hi", assert }) as unknown as Scenario;

describe.skipIf(!havePython)("gate-assert-contradiction: TS refusal ↔ Python lint rule", () => {
  it("both sides trigger on the same three presence keys", () => {
    const cases = [
      ["gate_answer_count_min", { gate_answer_count_min: 1 }, "  - gate_answer_count_min: 1\n"],
      ["question_asked", { question_asked: "x" }, '  - question_asked: "x"\n'],
      ["gate_answers_delivered: false", { gate_answers_delivered: false }, "  - gate_answers_delivered: false\n"],
    ] as const;
    for (const [label, presence, yaml] of cases) {
      expect(gateAssertContradiction(scenario([{ questions_count_max: 0 }, presence])), `TS lost the ${label} trigger`).toBeDefined();
      expect(lintContradiction(`assert:\n  - questions_count_max: 0\n${yaml}`), `lint lost the ${label} trigger`).toBeDefined();
    }
  });

  it("neither side triggers on the satisfiable neighbours", () => {
    // `: true` passes vacuously at zero gates and `>= 0` always holds — inert next to the declaration,
    // not contradictory. One side refusing what the other allows is worse than either alone.
    expect(gateAssertContradiction(scenario([{ questions_count_max: 0 }, { gate_answers_delivered: true }]))).toBeUndefined();
    expect(lintContradiction("assert:\n  - questions_count_max: 0\n  - gate_answers_delivered: true\n")).toBeUndefined();
    expect(gateAssertContradiction(scenario([{ questions_count_max: 0 }, { gate_answer_count_min: 0 }]))).toBeUndefined();
    expect(lintContradiction("assert:\n  - questions_count_max: 0\n  - gate_answer_count_min: 0\n")).toBeUndefined();
  });

  it("both messages make the same claim, in the same words", () => {
    const ts = gateAssertContradiction(scenario([{ questions_count_max: 0 }, { gate_answer_count_min: 1 }]))!;
    const lint = lintContradiction("assert:\n  - questions_count_max: 0\n  - gate_answer_count_min: 1\n")!;
    // The load-bearing sentence — WHY the pairing is refused. A user who hits one message and then the
    // other must read one explanation, not two.
    for (const phrase of ["no run can satisfy both", "A delivered gate records at least one question"]) {
      expect(ts, `the TS refusal lost "${phrase}"`).toContain(phrase);
      expect(lint.message, `the lint finding lost "${phrase}"`).toContain(phrase);
    }
  });

  it("both offer the same two-way remedy", () => {
    const ts = gateAssertContradiction(scenario([{ questions_count_max: 0 }, { question_asked: "x" }]))!;
    const lint = lintContradiction('assert:\n  - questions_count_max: 0\n  - question_asked: "x"\n')!;
    const remedy = "Keep the zero-gate declaration and drop the presence assertion, or drop";
    expect(ts).toContain(remedy);
    expect(lint.fix, "the lint fix line drifted from the TS refusal's remedy").toContain(remedy);
  });

  it("the lint side is ERROR, matching a refusal rather than an advisory", () => {
    expect(lintContradiction("assert:\n  - questions_count_max: 0\n  - gate_answer_count_min: 1\n")!.severity).toBe("ERROR");
  });
});
