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
    expect(errs.join("\n")).toContain("2.1.215"); // the superseded agent is named
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
    ["the named agent version is superseded", note({ agent: "2.1.222" }), `agent "2.1.222" != max baseline's agentVersion`],
    ["the list is out of order", note({ list: ["1.23.0", "1.22.0", "1.24.0", "1.25.0", "1.26.0"] }), "stale or out of order"],
    ["a listed baseline has no baselines/desktop-*.json", note({ list: ["1.22.0", "1.99.0"] }), "no baselines/desktop-*.json"],
    ["the note is deleted entirely", "DESIGN.md with no scope note at all", "has no"],
    ["the note is reworded past recognition", "> **Scope of that claim, stated plainly.** we checked some stuff.", "live-pass baseline"],
    [
      "the note keeps its live-pass baseline but loses the enumeration",
      "> **Scope of that claim, stated plainly.** `2026-07-11 / desktop-1.20.0` — we checked some stuff, it was fine.",
      "must read",
    ],
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
      `> **Scope of that claim, stated plainly.** \`2026-07-11 / desktop-1.20.0\` — we checked some stuff.\n` +
      `\`2026-07-11 / desktop-1.20.0\` is the last baseline carrying a pass; five baselines have shipped since ` +
      `(\`1.22.0\`, \`1.23.0\`, \`1.24.0\`, \`1.25.0\`, \`1.26.0\`), **three** of which moved the agent ELF — ` +
      `most recently to **${MAX_AGENT}**.\n`;
    // Line 2 is a COMPLETE, CORRECT note. If the matcher widened past the newline it would find it and
    // report nothing; correct behaviour is to reject line 1 for carrying no enumeration.
    expect(run(decoyed).join("\n")).toContain("must read");
  });

  it("accepts digits as well as words, so the note can be rephrased without silently disabling the check", () => {
    expect(run(note({ count: "5", moves: "3" }))).toEqual([]);
  });

  it("an unparseable number is an error, never a silent skip", () => {
    expect(run(note({ count: "several" })).join("\n")).toContain("not a number this check understands");
  });

  // ── NO-GAP form: the live pass IS the newest baseline, so there is nothing to enumerate ───────────
  describe("no-gap form (live pass == newest baseline)", () => {
    const noGap = (opts: { pass?: string; agent?: string; extra?: string } = {}) =>
      `> **Scope of that claim, stated plainly.** \`2026-08-14 / desktop-${opts.pass ?? MAX}\` is the last ` +
      `baseline carrying a **full live end-to-end pass**, and it is the newest committed baseline — ` +
      `**no baselines have shipped since**. The pass ran against agent **${opts.agent ?? MAX_AGENT}** and ` +
      `covered all three tiers.${opts.extra ?? ""}\n`;

    it("is clean when the live pass is the newest baseline", () => {
      expect(run(noGap())).toEqual([]);
    });

    // THE ONE THAT MATTERS. A no-gap note is only true until the next baseline ships; after that the
    // note silently overstates coverage unless something forces a rewrite. This is that force.
    it("REGRESSION: shipping a new baseline invalidates a no-gap note (it must be rewritten, not left)", () => {
      const shipped = [...BASELINES, "1.27.0"];
      const errs = checkDesignScopeNote({
        design: noGap(), // still claims the pass at 1.26.0 is the newest — no longer true
        baselineVersions: shipped,
        agentOf: (v) => (v === "1.27.0" ? "2.1.231" : AGENTS[v]),
        maxBaseline: "1.27.0",
        maxAgentVersion: "2.1.231",
      });
      expect(errs.length, "a stale no-gap note must not pass").toBeGreaterThan(0);
      // It falls through to the gap form, which demands the enumeration the note no longer has.
      expect(errs.join("\n")).toContain("must read");
    });

    it("MUTATION: drops the explicit no-gap assertion → fails loud", () => {
      const withoutPhrase = noGap().replace("— **no baselines have shipped since**", "—");
      expect(run(withoutPhrase).join("\n")).toContain('must state "no baselines have shipped since"');
    });

    it("MUTATION: keeps a stale enumeration alongside the no-gap claim → fails loud", () => {
      const withList = noGap({ extra: " Also: two baselines have shipped since (`1.24.0`, `1.25.0`)." });
      expect(run(withList).join("\n")).toContain("still carries");
    });

    it("MUTATION: names a superseded agent → fails loud", () => {
      expect(run(noGap({ agent: "2.1.222" })).join("\n")).toContain(`agent "2.1.222" != max baseline's agentVersion`);
    });

    it("MUTATION: names a live-pass baseline that does not exist → fails loud", () => {
      expect(run(noGap({ pass: "9.9.9" })).join("\n")).toContain("no baselines/desktop-*.json");
    });
  });
});
