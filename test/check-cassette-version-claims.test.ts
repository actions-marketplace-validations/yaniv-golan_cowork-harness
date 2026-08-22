import { describe, it, expect } from "vitest";
import { checkCassetteVersionClaims } from "../scripts/check-versions.js";

/**
 * Invariant 12 (check:versions) — the docs' cassette-FORMAT claims against the constants.
 *
 * `CASSETTE_VERSION` reached 12 while `task-recipes.md` still linked `schema/cassette.v11.json` and called
 * 11 "current max", and `SPEC.md` said v9 and v10 were retained "alongside v11". Three present-tense claims,
 * all stale, none caught by anything.
 *
 * A green run proves nothing on its own, so every case below is a way a claim can go wrong and each must be
 * observed to FAIL. Two matter most: the real historical text must be REJECTED, and the correct history in
 * `docs/scenario.md` / `docs/cassette.md` — which discuss v10 and v11 at length, accurately — must be
 * ACCEPTED, because a guard that flags those trains the next author to route around it.
 */

const SPEC_OK = `
- **Cassette format** — the maximum \`cassetteVersion\` this build writes/reads is **12**
  (\`schema/cassette.v12.json\`) and its verdict-modifier assertion keys.

  The minimum supported read version is **v9**
  (\`MIN_SUPPORTED_CASSETTE_VERSION\`): a cassette below the floor is refused at load time with a
  re-record error (their schema files are no longer shipped; the retained schema files are
  \`schema/cassette.v9.json\` through \`schema/cassette.v12.json\`).
`;

const RECIPES_OK = [
  "Top-level fields of a `*.cassette.json` (schema [`schema/cassette.v12.json`]" +
    "(https://github.com/yaniv-golan/cowork-harness/blob/main/schema/cassette.v12.json)):",
  "| `$schema` | ... (current max: 12 — since the hash-format epoch every stamp floors there) |",
].join("\n");

const base = {
  current: 12,
  minSupported: 9,
  retained: [9, 10, 11, 12],
  spec: SPEC_OK,
  taskRecipes: RECIPES_OK,
  // 20 filler entries so the corpus floor is satisfied; individual cases add the doc under test.
  docs: Array.from({ length: 20 }, (_, i) => ({ path: `docs/filler-${i}.md`, text: "" })),
};

const run = (over: Partial<typeof base> = {}) => checkCassetteVersionClaims({ ...base, ...over });

describe("invariant 12 · cassette-format claims track the constants", () => {
  it("accepts the corrected docs", () => {
    expect(run()).toEqual([]);
  });

  it("REJECTS the real text that shipped stale", () => {
    // The three claims exactly as they read before this guard existed.
    const errs = run({
      spec: SPEC_OK.replace(
        "the retained schema files are\n  `schema/cassette.v9.json` through `schema/cassette.v12.json`",
        "`schema/cassette.v9.json` and `schema/cassette.v10.json` are\n  both retained alongside v11",
      ),
      taskRecipes: RECIPES_OK.replaceAll("v12", "v11").replace("current max: 12", "current max: 11"),
    });
    expect(errs).toHaveLength(3);
    expect(errs.join("\n")).toContain("cassette.v11.json");
    expect(errs.join("\n")).toContain('"current max: 11"');
    expect(errs.join("\n")).toContain('has no "the retained schema files are');
  });

  it("leaves correct HISTORY alone — this is a current-claims guard, not a version-mention ban", () => {
    // Real sentences from docs/scenario.md and docs/cassette.md. Flagging these would be the failure that
    // teaches the next author to work around the check.
    const history = [
      { path: "docs/scenario.md", text: "A cassette recorded by **>= 1.16.0** whose scenario carries `lane: remote` is stamped v11." },
      { path: "docs/cassette.md", text: "carrying `lane: remote` is stamped v10 and is still silently misread by a pre-`lane` CLI" },
      { path: "docs/cassette.md", text: "an older CLI replays the v11 cassette and the silent misread returns" },
    ];
    expect(run({ docs: [...base.docs, ...history] })).toEqual([]);
  });

  it("fails when a doc links a schema file that is not on disk", () => {
    const errs = run({ docs: [...base.docs, { path: "docs/x.md", text: "see `schema/cassette.v8.json` for the shape" }] });
    expect(errs).toEqual(["docs/x.md references schema/cassette.v8.json, which is not in schema/ (have v9, v10, v11, v12)"]);
  });

  it.each([
    ["SPEC max claim", { spec: SPEC_OK.replace("is **12**", "is **11**") }, "maximum cassetteVersion is 11"],
    [
      "SPEC current-schema link",
      { spec: SPEC_OK.replace("(`schema/cassette.v12.json`) and", "(`schema/cassette.v11.json`) and") },
      "as the current schema",
    ],
    ["SPEC read floor", { spec: SPEC_OK.replace("is **v9**", "is **v8**") }, "minimum supported read version is v8"],
    ["retained range start", { retained: [10, 11, 12] }, "retained schemas start at v9; schema/ starts at v10"],
    ["retained range end", { current: 13, retained: [9, 10, 11, 12, 13] }, "retained schemas end at v12; schema/ ends at v13"],
    [
      "recipes schema pointer",
      { taskRecipes: RECIPES_OK.replace("[`schema/cassette.v12.json`]", "[`schema/cassette.v11.json`]") },
      "points a skill author at schema/cassette.v11.json",
    ],
    ["recipes current max", { taskRecipes: RECIPES_OK.replace("current max: 12", "current max: 10") }, 'says "current max: 10"'],
  ])("fails on a drifted %s", (_name, over, needle) => {
    expect(run(over).join("\n")).toContain(needle);
  });

  it("fails when a claim is REWORDED AWAY rather than corrected", () => {
    // The failure mode that matters most for a prose guard: silently becoming a no-op.
    for (const over of [
      { spec: SPEC_OK.replace("the maximum `cassetteVersion` this build writes/reads is", "the top format version is") },
      { spec: SPEC_OK.replace("The minimum supported read version is", "The read floor is") },
      { taskRecipes: RECIPES_OK.replace("current max: 12", "top: 12") },
      { taskRecipes: RECIPES_OK.replace("Top-level fields of a", "Fields of a") },
    ]) {
      expect(run(over).join("\n")).toContain("to verify (invariant 12)");
    }
  });

  it("fails when the link text and the URL disagree", () => {
    const errs = run({ taskRecipes: RECIPES_OK.replace("blob/main/schema/cassette.v12.json", "blob/main/schema/cassette.v11.json") });
    expect(errs.join("\n")).toContain("text and URL disagree");
  });

  it("refuses a `through` range once schema/ stops being contiguous", () => {
    expect(run({ retained: [9, 12] }).join("\n")).toContain("no longer contiguous");
  });

  it("reports an unreadable constant instead of passing", () => {
    // A regex that stops matching the source yields NaN. Silently treating that as "nothing to check"
    // is how a version guard dies without anyone noticing.
    expect(run({ current: NaN }).join("\n")).toContain("could not read CASSETTE_VERSION");
    expect(run({ minSupported: NaN }).join("\n")).toContain("could not read MIN_SUPPORTED_CASSETTE_VERSION");
    expect(run({ retained: [] }).join("\n")).toContain("schema sweep would be vacuous");
    expect(run({ docs: [] }).join("\n")).toContain("near-vacuous");
  });
});
