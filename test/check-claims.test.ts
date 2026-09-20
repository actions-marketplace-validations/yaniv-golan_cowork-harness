/**
 * Guards the binary-claim staleness REPORT (`npm run check:claims`).
 *
 * The report is not a gate — it exits 0 by design (see the script header for why a hard fail would be a
 * copy-paste-satisfiable guard). But a report that silently finds NOTHING is the classic false green: the
 * walk breaks, the output reads clean, and the population it exists to surface disappears. So pin that it
 * scans a non-trivial population and still recognises the stamp shapes actually used in this repo.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";

const out = execFileSync("npx", ["tsx", "scripts/check-claims.ts"], { encoding: "utf8", cwd: process.cwd() });

describe("check:claims report", () => {
  it("finds a non-trivial population of version-stamped claims", () => {
    const m = out.match(/(\d+) version-stamped claim\(s\) across (\d+) file\(s\)/);
    expect(m, `report did not print its population line:\n${out.slice(0, 400)}`).toBeTruthy();
    // Measured at 49 across 23 files on 2026-09-08. The floor is deliberately well below that: this
    // catches a broken walk, not ordinary drift in how many claims exist.
    expect(Number(m![1])).toBeGreaterThan(20);
    expect(Number(m![2])).toBeGreaterThan(5);
  });

  it("recognises both stamp kinds, not just one", () => {
    // A regex that quietly stopped matching one kind would halve the report with no visible symptom.
    expect(out).toMatch(/\bagent\s+\d+\.\d+\.\d+/);
    expect(out).toMatch(/\basar\s+\d+\.\d+\.\d+/);
  });

  it("names the pinned versions it compared against", () => {
    expect(out).toMatch(/pinned agent \d+\.\d+\.\d+, pinned asar \d+\.\d+\.\d+/);
  });

  it("says it is a report and not a gate, so nobody wires it into CI as one", () => {
    expect(out).toContain("REPORT ONLY");
  });
});
