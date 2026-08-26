import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { TOOL_USE_BLIND_KEYS, MODEL_AUTHORED_TEXT_KEYS } from "../src/run/cassette.js";
import { Assertion } from "../src/types.js";

// WHY THIS FILE EXISTS. `semantic_matches` has carried a ⚠️ since 2026-07 spelling out that its corpus
// excludes every tool_use — "a rubric claim about whether a tool was called is unassertable". The four
// transcript keys have the IDENTICAL blindness and said only "the assistant transcript". A consumer
// reached for `transcript_matches` against text living in a gate question, and it could not have matched
// at any phrasing; the recording fail-closed after the money was spent.
//
// docs/scenario.md is already guarded for key PRESENCE (scenario-docs-sync.test.ts), so a new key cannot
// ship undocumented. Nothing guarded the CAVEAT, which is why the asymmetry survived a year. These tests
// close that: the caveat is now a property of an enumerable set, not of prose someone remembered to paste.
//
// On the copy-paste objection: yes, a developer satisfies this by pasting the sentence onto the row. That
// is the intended action. The rot mode being guarded is a NEW blind/model-authored key added with no
// caveat at all — and an enumerable set catches exactly that.

const scenarioDoc = readFileSync("docs/scenario.md", "utf8");
const cassetteDoc = readFileSync("docs/cassette.md", "utf8");

const TOOL_USE_SENTINEL = "excludes every `tool_use`/`tool_result`";
const DRIFT_SENTINEL = "model-composed and is reworded run to run";

/** The one table row documenting `key`, or undefined. Rows open with `| \`key` — matching the backtick
 *  prevents `transcript_matches` from being satisfied by `transcript_not_matches`' row. */
function row(doc: string, key: string): string | undefined {
  for (const line of doc.split("\n")) {
    if (!line.startsWith("| `")) continue;
    const name = line.slice(3).split(/[`:]/)[0];
    if (name === key) return line;
  }
  return undefined;
}

describe("keys blind to tool_use carry the exclusion in their docs row", () => {
  it("the sets are non-empty and every member is a real assertion key (an anchor that rots must fail HERE)", () => {
    expect(TOOL_USE_BLIND_KEYS.length).toBeGreaterThan(0);
    expect(MODEL_AUTHORED_TEXT_KEYS.length).toBeGreaterThan(0);
    const real = new Set(Object.keys(Assertion.shape));
    expect(TOOL_USE_BLIND_KEYS.filter((k) => !real.has(k as string))).toEqual([]);
    expect(MODEL_AUTHORED_TEXT_KEYS.filter((k) => !real.has(k as string))).toEqual([]);
  });

  it.each(TOOL_USE_BLIND_KEYS)("docs/scenario.md documents %s with the tool_use exclusion", (key) => {
    const r = row(scenarioDoc, key as string);
    expect(r, `docs/scenario.md has no table row for ${key}`).toBeDefined();
    expect(r, `docs/scenario.md's ${key} row must say it ${TOOL_USE_SENTINEL}`).toContain(TOOL_USE_SENTINEL);
  });

  // cassette.md's replay table covers a subset; where it DOES describe one of these keys, the caveat has to
  // travel with it — that table is what a reader consults when placing an assert in CI.
  it.each(TOOL_USE_BLIND_KEYS)("docs/cassette.md's row for %s, where it has one, carries it too", (key) => {
    const r = row(cassetteDoc, key as string);
    if (r === undefined) return;
    expect(r, `docs/cassette.md's ${key} row must say it ${TOOL_USE_SENTINEL}`).toContain(TOOL_USE_SENTINEL);
  });

  it.each(MODEL_AUTHORED_TEXT_KEYS)("docs/scenario.md warns that %s matches model-authored text", (key) => {
    const r = row(scenarioDoc, key as string);
    expect(r, `docs/scenario.md has no table row for ${key}`).toBeDefined();
    expect(r, `docs/scenario.md's ${key} row must say the text is ${DRIFT_SENTINEL}`).toContain(DRIFT_SENTINEL);
  });

  // BOTH DIRECTIONS, or this file is decorative: a guard that only ever checks the rows that already pass
  // cannot fail. These prove the two ways it is meant to break.
  it("fails when a member's caveat is deleted", () => {
    const key = "transcript_matches";
    const before = row(scenarioDoc, key)!;
    // Mutate THAT ROW, not the first occurrence in the file. A whole-document `.replace()` hits
    // semantic_matches' row (it appears earlier and already carried the sentence), so the document
    // changes, this test goes green, and it proves nothing about the row under test. That near-miss is
    // why the mutation is anchored and then re-asserted below.
    const mutated = scenarioDoc.replace(before, before.replace(TOOL_USE_SENTINEL, "the assistant transcript"));
    const after = row(mutated, key)!;
    expect(after, "mutation did not apply to the row under test").not.toEqual(before);
    expect(after).not.toContain(TOOL_USE_SENTINEL);
    // ...and the rest of the table is untouched, so a green above is about this row alone.
    expect(row(mutated, "semantic_matches")).toContain(TOOL_USE_SENTINEL);
  });

  // The other direction, and it must EXERCISE the guard rather than the helper. Asserting that
  // `row(doc, "made_up")` is undefined proves only that the lookup works; it says nothing about whether a
  // set member with no row would actually be caught. So run the guard's own predicate over a set with an
  // extra member and require a failure.
  it("fails when a key is added to the set with no documented row", () => {
    const check = (keys: string[]) =>
      keys
        .map((k) => {
          const r = row(scenarioDoc, k);
          return r === undefined || !r.includes(TOOL_USE_SENTINEL) ? k : undefined;
        })
        .filter((k): k is string => k !== undefined);

    // The real set passes the predicate today...
    expect(check(TOOL_USE_BLIND_KEYS as string[])).toEqual([]);
    // ...and the same predicate catches an undocumented member, which is the rot mode this file exists for.
    expect(check([...(TOOL_USE_BLIND_KEYS as string[]), "tool_result_contains"])).toEqual(["tool_result_contains"]);
  });

  // transcript_no_host_path LOOKS like a transcript key and is deliberately excluded: it reads the post-run
  // host-path scan (ctx.hostPathLeaked), not the transcript string. Pinning the exclusion stops a later
  // "tidy-up" from sweeping it in and attaching a caveat that would be false.
  it("does not sweep in transcript_no_host_path, which reads a scan and not the transcript", () => {
    expect(TOOL_USE_BLIND_KEYS).not.toContain("transcript_no_host_path");
  });
});
