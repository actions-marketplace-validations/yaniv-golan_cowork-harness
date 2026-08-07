import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// `runBoundaryChecks` needs Docker, so no unit test can call it and observe its check set. But the
// check NAMES are the user-facing contract: they are printed by `boundary-check`, quoted verbatim in
// docs/boundary.md's sample output, and counted in prose ("all five constraints"). Adding a probe
// without updating those left them silently wrong before, which is the rot this pins.
//
// Source-text assertion by design: it costs no container and still fails the moment the set drifts.

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The boundary constraints, in the order `runBoundaryChecks` pushes them. */
const EXPECTED_CHECKS = [
  "host-fs-sealed",
  "direct-egress-denied",
  "allowlist-enforced",
  "allowlist-permits",
  "loopback-not-proxied",
] as const;

const boundarySrc = () => readFileSync(join(REPO_ROOT, "src/boundary.ts"), "utf8");
const boundaryDoc = () => readFileSync(join(REPO_ROOT, "docs/boundary.md"), "utf8");

describe("boundary check set is pinned to its docs", () => {
  it("src/boundary.ts pushes exactly the expected checks, in order", () => {
    const found = [...boundarySrc().matchAll(/^\s*check: "([^"]+)"/gm)].map((m) => m[1]);
    expect(
      found,
      "the boundary check set changed — update EXPECTED_CHECKS here, docs/boundary.md's sample output, " +
        "the constraint count in src/boundary.ts's docblock, and the boundary-check row in README.md",
    ).toEqual([...EXPECTED_CHECKS]);
  });

  it("every check name appears in docs/boundary.md's sample output", () => {
    const doc = boundaryDoc();
    const missing = EXPECTED_CHECKS.filter((c) => !doc.includes(c));
    expect(missing, `check names absent from docs/boundary.md: ${missing.join(", ")}`).toEqual([]);
  });

  it("the docblock's constraint count matches the number of checks", () => {
    // Spelled out ("all five constraints"), so a numeral-free prose count still has to move.
    const words = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight"];
    const expected = `all ${words[EXPECTED_CHECKS.length]} constraints`;
    expect(
      boundarySrc().includes(expected),
      `src/boundary.ts's docblock should read "${expected}" — it counts the checks and goes stale silently`,
    ).toBe(true);
  });
});
