import { describe, it, expect } from "vitest";
import { checkDesignScopeNote } from "../scripts/check-versions.js";

/**
 * Invariant 11 (check:versions) — DESIGN.md's "Scope of that claim" note.
 *
 * That note is the repo's honest disclosure of how much of the CURRENT baseline is live-verified, and it
 * had already drifted twice before this guard existed: the baseline list was extended without recounting,
 * leaving "four of which moved the agent ELF" when six of the nine listed had. Understating how much is
 * UNVERIFIED is the doc error worth failing a release over.
 *
 * So a green run of this guard proves nothing on its own — every row below is a way the note can go wrong,
 * and each must be observed to FAIL. The first test is the one that matters: it replays the real historical
 * text and requires the guard to reject it.
 */

// A synthetic baseline set with a deliberate mix of ELF moves and holds, so the move count is not simply
// "one per baseline" and an off-by-one is visible.
const AGENTS: Record<string, string> = {
  "1.10.0": "2.1.200",
  "1.20.0": "2.1.202", // <- the live-pass baseline
  "1.21.0": "2.1.205", // (omitted from the note, like the real one omits 1.20186.1)
  "1.22.0": "2.1.205", // hold
  "1.23.0": "2.1.209", // move 1
  "1.24.0": "2.1.209", // hold
  "1.25.0": "2.1.215", // move 2
  "1.26.0": "2.1.229", // move 3
};
const BASELINES = Object.keys(AGENTS);
const agentOf = (v: string) => AGENTS[v];
const MAX = "1.26.0";
const MAX_AGENT = "2.1.229";

/** The note as it should read for the fixture above: lists 1.22.0..1.26.0 (five), three ELF moves. */
const note = (opts: { count?: string; list?: string[]; moves?: string; agent?: string } = {}) => {
  const list = opts.list ?? ["1.22.0", "1.23.0", "1.24.0", "1.25.0", "1.26.0"];
  return (
    `> **Scope of that claim, stated plainly.** \`2026-07-11 / desktop-1.20.0\` is the last baseline ` +
    `carrying a **full live end-to-end pass**; ${opts.count ?? "five"} baselines have shipped since ` +
    `(${list.map((v) => `\`${v}\``).join(", ")}), **${opts.moves ?? "three"}** of which moved the agent ` +
    `ELF — most recently to **${opts.agent ?? MAX_AGENT}**. Those were verified the cheaper way.\n` +
    `next line must not be scanned: nine baselines have shipped since (\`9.9.9\`), **one** of which moved the agent ELF — most recently to **9.9.9**.\n`
  );
};

const run = (design: string) =>
  checkDesignScopeNote({ design, baselineVersions: BASELINES, agentOf, maxBaseline: MAX, maxAgentVersion: MAX_AGENT });

describe("check:versions invariant 11 — DESIGN.md scope note", () => {
  it("a correct note is clean", () => {
    expect(run(note())).toEqual([]);
  });

  it("REGRESSION: rejects the real historical drift (list extended, counts never updated)", () => {
    // Exactly the shape that shipped: the newest baselines missing from the list, a stale count, a stale
    // ELF-move count, and a superseded agent version. Every one of these must be reported.
    const stale = note({ count: "three", list: ["1.22.0", "1.23.0", "1.24.0"], moves: "one", agent: "2.1.215" });
    const errs = run(stale);
    expect(errs.join("\n")).toContain("baseline list is stale");
    expect(errs.join("\n")).toContain("most recently to 2.1.215");
    // …and it names the baselines that were left out, so the fix is mechanical.
    expect(errs.join("\n")).toContain("1.26.0");
  });

  const MUT: ReadonlyArray<readonly [string, string, string]> = [
    [
      "a newly-shipped baseline is left out of the list",
      note({ count: "four", list: ["1.22.0", "1.23.0", "1.24.0", "1.25.0"], moves: "two" }),
      "baseline list is stale",
    ],
    ["the count word disagrees with the list", note({ count: "six" }), "says 6 baselines but lists 5"],
    ["the ELF-move count is wrong", note({ moves: "four" }), "moved the agent ELF; the baselines say 3"],
    ["the named agent version is superseded", note({ agent: "2.1.222" }), "most recently to 2.1.222"],
    ["the list is out of order", note({ list: ["1.23.0", "1.22.0", "1.24.0", "1.25.0", "1.26.0"] }), "stale or out of order"],
    ["a listed baseline has no baselines/desktop-*.json", note({ list: ["1.22.0", "1.99.0"] }), "no baselines/desktop-*.json"],
    ["the note is deleted entirely", "DESIGN.md with no scope note at all", "has no"],
    ["the note is reworded past recognition", "> **Scope of that claim, stated plainly.** we checked some stuff.", "no longer matches"],
  ];
  it.each(MUT)("MUTATION: %s → fails loud", (_label, design, expected) => {
    const errs = run(design);
    expect(errs.length, "guard must not pass this").toBeGreaterThan(0);
    expect(errs.join("\n")).toContain(expected);
  });

  it("scans only the note's own line — a well-formed LATER paragraph cannot satisfy a malformed note", () => {
    // The discriminating case: the anchor's own line is unparseable, and a perfectly-formed (and
    // correct-for-the-fixture) note sits on the NEXT line. Correct behaviour is to report the anchor line
    // as unparseable. If the matcher ever widened past the newline it would find the decoy, report
    // nothing, and the real line's drift would ship unnoticed — so this asserts the failure, not a pass.
    const decoyed =
      `> **Scope of that claim, stated plainly.** we checked some stuff and it was fine.\n` +
      `five baselines have shipped since (\`1.22.0\`, \`1.23.0\`, \`1.24.0\`, \`1.25.0\`, \`1.26.0\`), ` +
      `**three** of which moved the agent ELF — most recently to **${MAX_AGENT}**.\n`;
    expect(run(decoyed).join("\n")).toContain("no longer matches");
  });

  it("accepts digits as well as words, so the note can be rephrased without silently disabling the check", () => {
    expect(run(note({ count: "5", moves: "3" }))).toEqual([]);
  });

  it("an unparseable number is an error, never a silent skip", () => {
    expect(run(note({ count: "several" })).join("\n")).toContain("not a number this check understands");
  });
});
