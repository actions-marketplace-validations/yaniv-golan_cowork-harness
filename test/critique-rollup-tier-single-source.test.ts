import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

// THE HAZARD. `resolveGroups`'s second pass in src/run/run-index.ts files a roll-up's spend with
// `groups.get(key)?.spend.push(r)` — optional chaining. If a roll-up row's key ever pointed at a group
// no run row created, its cost is silently dropped from `totalUsd`: no throw, no warning, just a critique
// whose reported spend is quietly short. Under `--group-by fidelity` the key is `tierOf(r)`
// (`r.effectiveFidelity ?? r.fidelity`, defined in run-index.ts), which is never undefined, so a roll-up
// always keys on its OWN tier — the drop only fires if a critique's roll-up ever disagreed with its own
// turn rows about which tier it ran at.
//
// WHY THAT CANNOT HAPPEN TODAY — this is the precondition this file pins, not the drop itself:
//   1. `appendCritiqueRollupRow` has exactly ONE call site in src/ (src/critique/command.ts). A second,
//      unreviewed call site could stamp a tier from somewhere else entirely.
//   2. That call site passes `effectiveFidelity: gradedEffectiveFidelity`, and `gradedEffectiveFidelity`
//      is read off `taskRaw` — the graded turn's OWN result.json, via `readTurn1Result(outDir)` — the
//      exact same field (`result.effectiveFidelity`) that `indexRowFromResult` in run-index.ts stamps
//      onto that turn's own row. Same field, same file, read twice: it cannot disagree with itself.
//      It also passes `fidelity: opts.fidelity`, which critique resolves from the `cowork` sentinel to a
//      concrete literal exactly ONCE, at parse time (before either turn spawns) — never re-resolved
//      per-call, never re-derived via a fresh `decideLoopFromBaseline` call at roll-up time.
//   3. `tierOf` is still `effectiveFidelity ?? fidelity` — if a third field ever entered that
//      precedence, or the precedence order changed, this whole analysis would need re-doing.
//
// If any of these three stop being true, a roll-up's tier COULD diverge from its turns' tier, and the
// silent-drop path in `resolveGroups` becomes reachable. This test does not — and cannot — guard the drop
// itself: the drop is `?.`, deliberately left unguarded, because turning it into a runtime check
// (throw/warn on a keyless roll-up) would be dead code as long as the precondition below holds. Guarding
// dead code is how a real check gets skipped in review as "obviously unreachable" and then bit-rots
// silently. This test's job is narrower and cheaper: notice the MOMENT the precondition stops holding, so
// the drop's reachability is re-evaluated deliberately rather than discovered by a critique that quietly
// under-reports its own cost.
//
// Source-text only, like the sibling single-source tests — src/critique/command.ts is a CLI command
// module (spawns child processes, does file I/O as a side effect of being invoked), so it is imported
// elsewhere in this suite but there is no reason to pay that cost here: everything this file needs to
// check is a textual, structural fact about the source, not runtime behaviour.

function srcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...srcFiles(p));
    else if (p.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** Finds the first `marker...(...)` call starting at `marker` (which must itself end in "(") and returns
 *  the full `marker(...)` text, matched by paren depth rather than a fixed line count — the call spans
 *  many lines and a line-count slice would silently truncate if it grew or shrank. */
function extractCall(text: string, marker: string): string {
  const start = text.indexOf(marker);
  if (start === -1) throw new Error(`marker not found in source: ${marker}`);
  let depth = 0;
  let j = start + marker.length - 1; // index of the "(" that ends `marker`
  for (; j < text.length; j++) {
    if (text[j] === "(") depth++;
    else if (text[j] === ")") {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) throw new Error(`unbalanced parens extracting call: ${marker}`);
  return text.slice(start, j + 1);
}

const runIndexSrc = readFileSync(resolve("src/run/run-index.ts"), "utf8");
const commandSrc = readFileSync(resolve("src/critique/command.ts"), "utf8");

describe("critique roll-up tier — single source of truth for the resolveGroups drop precondition", () => {
  it("appendCritiqueRollupRow has exactly one call site in src/, and it is in critique/command.ts", () => {
    const CALL_RE = /appendCritiqueRollupRow\(/;
    const DEFINITION_RE = /\bfunction\s+appendCritiqueRollupRow\s*\($/;
    const callSites: { file: string; line: number; text: string }[] = [];
    for (const abs of srcFiles(resolve("src"))) {
      const rel = abs.replace(resolve(".") + "/", "");
      const lines = readFileSync(abs, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!CALL_RE.test(line)) return;
        // Exclude the definition itself (`export function appendCritiqueRollupRow(`) — everything else
        // that names it with a trailing "(" is a real invocation.
        if (DEFINITION_RE.test(line.replace(/^export\s+/, ""))) return;
        callSites.push({ file: rel, line: i + 1, text: line.trim() });
      });
    }
    // Pinned by FILE and TEXT, not by line: the invariant is "exactly one call site, and it is this
    // one", and a line number adds nothing to it while rotting on any unrelated edit above it (it did —
    // 1710 → 1743 — turning an ordinary change three functions away into a red guard).
    expect(
      callSites.map((c) => `${c.file}: ${c.text}`),
      "a second call site is an unreviewed path that could stamp a roll-up's tier differently from its turns' — this precondition test would then need re-deriving for that site too",
    ).toEqual(["src/critique/command.ts: appendCritiqueRollupRow(runsWriteRoot(), {"]);
  });

  it("the graded turn's own result.json is the ONLY source both the row and the roll-up read effectiveFidelity from", () => {
    // The turn row's own stamp — indexRowFromResult (run-index.ts) — reads it straight off the RunResult.
    expect(runIndexSrc, "run-index.ts no longer stamps a turn row's effectiveFidelity from result.effectiveFidelity").toMatch(
      /effectiveFidelity:\s*result\.effectiveFidelity\b/,
    );
    // The roll-up reads the SAME field off the SAME turn's result.json, via readTurn1Result — not from
    // opts, not re-computed.
    expect(commandSrc, "critique no longer reads taskRaw via readTurn1Result(outDir)").toMatch(
      /const taskRaw\s*=\s*readTurn1Result\(outDir\)/,
    );
    expect(
      commandSrc,
      "gradedEffectiveFidelity must come straight off taskRaw.effectiveFidelity — anything else breaks the same-source guarantee",
    ).toMatch(/const gradedEffectiveFidelity\s*=\s*typeof taskRaw\?\.effectiveFidelity/);
  });

  it("the one call site passes effectiveFidelity from the graded turn's result and fidelity from the once-resolved opts — never re-derived", () => {
    const call = extractCall(commandSrc, "appendCritiqueRollupRow(");
    expect(call, "call site must pass effectiveFidelity: gradedEffectiveFidelity").toMatch(
      /effectiveFidelity:\s*gradedEffectiveFidelity\b/,
    );
    expect(call, "call site must pass fidelity: opts.fidelity (the value resolved once at parse time)").toMatch(
      /fidelity:\s*opts\.fidelity\b/,
    );
    expect(
      call,
      "the call site must not re-derive a tier via a fresh decideLoopFromBaseline call — that would let it disagree with the turn rows it is supposed to match",
    ).not.toMatch(/decideLoopFromBaseline/);
  });

  it("tierOf is still effectiveFidelity ?? fidelity — the precedence the whole analysis above depends on", () => {
    expect(runIndexSrc, "tierOf's precedence changed — re-check whether a roll-up's key can still never diverge from its turns'").toMatch(
      /const tierOf\s*=\s*\(r: RunIndexRow\): string => r\.effectiveFidelity \?\? r\.fidelity;/,
    );
  });
});
