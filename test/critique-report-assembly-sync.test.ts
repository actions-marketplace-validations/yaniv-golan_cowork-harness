import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The integrity canary shipped INERT: the ReportState field, the renderer, the local variable and the
// callback all existed, and nothing ever put the value into a state literal — so the warning could not
// print in either format. Unit tests missed it because they hand the builders a state directly, testing
// the renderer rather than the assembly.
//
// Source-level guard, same shape as run-result-schema-sync. The FIRST version of this test grepped
// `^\s+field[,:]` anywhere after `async function main(`, which also matched main()'s own destructuring
// (`turn1ResultDegraded: trd,`) — deleting three fields from the real state literal left it green. It
// parses the actual ReportState object literals now.
const SRC = readFileSync(resolve("src/critique/command.ts"), "utf8");

function reportStateFields(): string[] {
  const block = SRC.slice(SRC.indexOf("interface ReportState"));
  const body = block.slice(0, block.indexOf("\n}"));
  return [...body.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]!);
}

/** Every `ReportState`-typed object literal in the file, as brace-balanced source text. */
function reportStateLiterals(): string[] {
  const out: string[] = [];
  const marker = ": ReportState = {";
  for (let i = SRC.indexOf(marker); i !== -1; i = SRC.indexOf(marker, i + 1)) {
    let depth = 0;
    const start = i + marker.length - 1;
    for (let j = start; j < SRC.length; j++) {
      if (SRC[j] === "{") depth++;
      else if (SRC[j] === "}" && --depth === 0) {
        out.push(SRC.slice(start, j + 1));
        break;
      }
    }
  }
  return out;
}

const LITERALS = reportStateLiterals();
const FIELDS = reportStateFields();
/** The success-path literal — the most complete one, and the only one that should carry everything. */
const FULL = LITERALS.reduce((a, b) => (b.length > a.length ? b : a), "");

describe("ReportState assembly", () => {
  it("finds the state literals to check (guards against the parser silently matching nothing)", () => {
    expect(LITERALS.length).toBeGreaterThanOrEqual(2);
    expect(FIELDS.length).toBeGreaterThan(8);
  });

  for (const field of FIELDS) {
    it(`\`${field}\` is assembled into the success-path state literal`, () => {
      const populated = new RegExp(`^\\s+${field}[,:]`, "m").test(FULL);
      expect(populated, `ReportState.${field} is declared and rendered but never assembled — the exact bug the canary shipped with`).toBe(
        true,
      );
    });
  }
});

// Early-return literals (task-infra failure, etc.) legitimately omit fields whose values do not exist yet
// — e.g. evaluatorIntegrity before the evaluator has run. In JSON an absent key and an `undefined` value
// are indistinguishable, and "absent = never checked" is the honest reading, so those omissions are
// correct rather than bugs. This test therefore pins the SUCCESS path only, deliberately.

// The guard above parses TOP-LEVEL ReportState fields only (`/^\s{2}(\w+)\??:/gm` — two spaces of
// indent). `evidenceBudget` is a NESTED object assembled in its own literal, so a field added to its
// interface and to the packager but never threaded into that literal ships inert with every test green —
// which is verbatim the failure this file exists to prevent, one level down. `corpusPackaged` shipped
// before this guard existed; `corpusOmitted` is covered by it.
describe("evidenceBudget assembly (the NESTED literal the top-level guard cannot see)", () => {
  function evidenceBudgetInterfaceFields(): string[] {
    const i = SRC.indexOf("evidenceBudget?: {");
    expect(i, "expected an `evidenceBudget?: {` block in ReportState").toBeGreaterThan(-1);
    const body = SRC.slice(i, SRC.indexOf("\n  };", i));
    return [...body.matchAll(/^\s{4}(\w+)\??:/gm)].map((m) => m[1]!);
  }
  /** The `evidenceBudget = { … }` assignment that feeds the report. */
  function evidenceBudgetLiteral(): string {
    const marker = "evidenceBudget = {";
    const i = SRC.indexOf(marker);
    expect(i, "expected an `evidenceBudget = {` assignment").toBeGreaterThan(-1);
    return SRC.slice(i, SRC.indexOf("\n      };", i));
  }

  it("every evidenceBudget interface field is actually assembled", () => {
    const literal = evidenceBudgetLiteral();
    const missing = evidenceBudgetInterfaceFields().filter((f) => !new RegExp(`^\\s+${f}[,:]`, "m").test(literal));
    expect(missing, `evidenceBudget fields declared but never assembled: ${missing.join(", ")}`).toEqual([]);
  });

  it("covers the fields this change added, so the guard cannot be trivially satisfied", () => {
    const fields = evidenceBudgetInterfaceFields();
    expect(fields).toContain("corpusPackaged");
    expect(fields).toContain("corpusOmitted");
  });
});
