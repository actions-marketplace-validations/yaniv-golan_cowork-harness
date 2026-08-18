import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { computeVerdict } from "../src/run/verdict.js";
import type { Assertion, RunResult } from "../src/types.js";

// `verdict.failures[]` is the machine-readable answer to "did MY assertions fail, or did something
// else?" — a consumer resorted to scraping stderr for it. The old answer was "look at whether
// `assertion` is set", which is wrong in BOTH directions: verify-run's answer-coverage misses inject a
// key and read as authored asserts, while guard / staleness / cassette-format failures all arrive
// key-less and indistinguishable. `kind` is the discriminator; these tests pin each value.

function res(assertions: RunResult["assertions"], over: Partial<RunResult> = {}): RunResult {
  return {
    scenario: "s",
    result: "success",
    assertions,
    durationMs: 1,
    outDir: "/tmp/x",
    fidelity: "container",
    baseline: "desktop-1.14271.0",
    ...over,
  } as unknown as RunResult;
}

const A = (a: Assertion, message: string, source?: "staleness" | "cassette-format" | "coverage") => ({
  assertion: a,
  pass: false,
  message,
  ...(source ? { source } : {}),
});

describe("verdict.failures[].kind", () => {
  it("an authored assert is kind: assertion, with its key", () => {
    const v = computeVerdict(res([A({ tool_called: "Bash" }, "expected Bash")]), "live");
    expect(v.failures).toEqual([{ assertion: "tool_called", message: "expected Bash", kind: "assertion" }]);
  });

  it("an injected staleness pseudo-assertion is kind: staleness, and carries no key", () => {
    const v = computeVerdict(res([A({} as Assertion, "skill-source drift (--fail-on-skill-drift): x", "staleness")]), "replay");
    expect(v.failures).toEqual([{ message: "skill-source drift (--fail-on-skill-drift): x", kind: "staleness" }]);
  });

  it("a too-new cassette is kind: cassette-format — distinct from staleness, which it used to be indistinguishable from", () => {
    const v = computeVerdict(res([A({} as Assertion, "cassette format too new: v12", "cassette-format")]), "replay");
    expect(v.failures[0].kind).toBe("cassette-format");
  });

  // The direction the old rule got backwards. verify-run injects `{ answer_coverage: q }`, which is not
  // an Assertion key — so `Object.keys(...)[0]` yields "answer_coverage" and the entry looked authored.
  it("an answer-coverage miss is kind: coverage even though it DOES carry a key", () => {
    const v = computeVerdict(
      res([A({ answer_coverage: "Which stage?" } as unknown as Assertion, "no answer rule matched", "coverage")]),
      "live",
    );
    expect(v.failures).toHaveLength(1);
    expect(v.failures[0].assertion).toBe("answer_coverage");
    expect(v.failures[0].kind).toBe("coverage");
    // The regression: filtering on key-presence would count this as one of the author's own asserts.
    expect(v.failures.filter((f) => f.kind === "assertion")).toHaveLength(0);
  });

  it("a guard signal the author never wrote is kind: guard", () => {
    const v = computeVerdict(
      res([], { result: "error", infraErrors: [{ source: "sidecar", message: "sidecar exited 1" }] } as unknown as Partial<RunResult>),
      "live",
    );
    expect(v.failures.length).toBeGreaterThan(0);
    expect(v.failures.every((f) => f.kind === "guard")).toBe(true);
  });

  it("a mixed run separates cleanly — the whole point of the field", () => {
    const v = computeVerdict(
      res([A({ tool_called: "Bash" }, "expected Bash"), A({} as Assertion, "cassette stale (--strict): skill files changed", "staleness")]),
      "replay",
    );
    expect(v.failures.filter((f) => f.kind === "assertion").map((f) => f.assertion)).toEqual(["tool_called"]);
    expect(v.failures.filter((f) => f.kind === "staleness")).toHaveLength(1);
  });

  it("every entry carries a kind — no undefined slips through either loop", () => {
    const v = computeVerdict(
      res([A({ tool_called: "Bash" }, "x")], { result: "error", unansweredGate: { message: "gate blew up" } } as Partial<RunResult>),
      "live",
    );
    expect(v.failures.length).toBeGreaterThan(1);
    expect(v.failures.every((f) => typeof f.kind === "string")).toBe(true);
  });
});

// Every INJECTION SITE must stamp `source`, or its failure silently renders as one of the author's own
// asserts. A unit test can only cover the sites it happens to construct; this scans for the pattern
// itself, so a NEW pseudo-assertion added anywhere reds until it is classified. (Mutation-found: the
// first version of this PR could lose a `source: "coverage"` stamp in cli.ts with every test green.)
describe("every pseudo-assertion injection site stamps `source`", () => {
  const files = ["src/run/cassette.ts", "src/cli.ts"];

  it("finds the sites at all (guards against a refactor that changes the shape)", () => {
    const total = files.reduce(
      (n, f) => n + [...readFileSync(resolve(f), "utf8").matchAll(/assertion: \{[^}]*\} as (?:unknown as )?Assertion,/g)].length,
      0,
    );
    // 3 in cassette.ts (--strict staleness, --fail-on-skill-drift, future-version) + 2 in cli.ts
    // (answer-coverage: no rule matched, and the invalid-answer throw).
    expect(total).toBe(5);
  });

  it("each one is followed by a `source:` within its object literal", () => {
    const unstamped: string[] = [];
    for (const f of files) {
      const src = readFileSync(resolve(f), "utf8");
      for (const m of src.matchAll(/assertion: \{[^}]*\} as (?:unknown as )?Assertion,/g)) {
        // The stamp may sit on either side of the `assertion:` line inside the same push({...}).
        const start = Math.max(0, src.lastIndexOf("push({", m.index));
        const end = src.indexOf("});", m.index);
        const literal = src.slice(start, end === -1 ? m.index! + 400 : end);
        if (!/source:\s*"(staleness|cassette-format|coverage)"/.test(literal)) {
          unstamped.push(`${f}: ...${src.slice(m.index!, m.index! + 60)}`);
        }
      }
    }
    expect(unstamped, "an injected pseudo-assertion with no `source` renders as one of the author's own asserts").toEqual([]);
  });
});
