import { describe, it, expect } from "vitest";
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  planMutations,
  planMutationsWithStats,
  summarizeMutationPlan,
  matchesAnyGlob,
  applyMutation,
  explainNoMutations,
  type Mutation,
} from "../src/run/mutate.js";

function artifact(path: string, doc: unknown) {
  return { path, body: JSON.stringify(doc) };
}

describe("planMutations — leaf perturbation", () => {
  it("perturbs a number leaf by +1 (equality/range-assert detectable)", () => {
    const plan = planMutations([artifact("out.json", { count: 42 })]);
    expect(plan).toEqual([
      {
        file: "out.json",
        path: "count",
        before: 42,
        after: 43,
        label: "out.json  count: 42 → 43",
      },
    ]);
  });

  it("perturbs a string leaf to the __MUTATED__ sentinel, not an empty string", () => {
    const plan = planMutations([artifact("out.json", { name: "alice" })]);
    expect(plan).toHaveLength(1);
    expect(plan[0].after).toBe("__MUTATED__");
    expect(plan[0].after).not.toBe("");
  });

  it("perturbs a boolean leaf by negation", () => {
    const plan = planMutations([artifact("out.json", { enabled: true })]);
    expect(plan).toEqual([
      {
        file: "out.json",
        path: "enabled",
        before: true,
        after: false,
        label: "out.json  enabled: true → false",
      },
    ]);
  });

  it("skips null leaves — perturbing them is an ambiguous 'was this real?' probe", () => {
    const plan = planMutations([artifact("out.json", { maybe: null, count: 1 })]);
    expect(plan.map((m) => m.path)).toEqual(["count"]);
  });

  it("recurses into nested objects and arrays with correct dotted paths", () => {
    const plan = planMutations([
      artifact("out.json", {
        totals: { revenue: 100 },
        rows: [{ currency: "usd" }, { currency: "eur" }],
      }),
    ]);
    const paths = plan.map((m) => m.path).sort();
    expect(paths).toEqual(["rows.0.currency", "rows.1.currency", "totals.revenue"]);
  });

  it("never replaces a whole container — only leaves are ever mutated", () => {
    const plan = planMutations([artifact("out.json", { totals: { revenue: 100 } })]);
    // The only mutation is at the leaf path "totals.revenue"; nothing at path "totals" itself.
    expect(plan.some((m) => m.path === "totals")).toBe(false);
    expect(plan.some((m) => m.path === "totals.revenue")).toBe(true);
  });

  it("skips a leaf whose key contains a literal '.' — its dotted path would be ambiguous", () => {
    const plan = planMutations([artifact("out.json", { "a.b": 1, ok: 2 })]);
    expect(plan.map((m) => m.path)).toEqual(["ok"]);
  });
});

describe("planMutations — non-JSON artifacts", () => {
  it("skips a body that fails to parse as JSON, without throwing", () => {
    expect(() => planMutations([{ path: "notes.json", body: "not valid json {" }])).not.toThrow();
    expect(planMutations([{ path: "notes.json", body: "not valid json {" }])).toEqual([]);
  });

  it("skips non-.json paths even when the body happens to be valid JSON text", () => {
    expect(planMutations([{ path: "notes.txt", body: JSON.stringify({ n: 1 }) }])).toEqual([]);
  });

  it("skips an artifact with no body (e.g. a truncated recording) without throwing", () => {
    const truncated = { path: "big.json" } as unknown as { path: string; body: string };
    expect(() => planMutations([truncated])).not.toThrow();
    expect(planMutations([truncated])).toEqual([]);
  });
});

describe("planMutations — bounding", () => {
  function docWithNLeaves(n: number): Record<string, number> {
    const doc: Record<string, number> = {};
    for (let i = 0; i < n; i++) doc[`field${i}`] = i;
    return doc;
  }

  it("caps a single file's mutations at maxPerFile by default (10)", () => {
    const plan = planMutations([artifact("big.json", docWithNLeaves(100))]);
    expect(plan.length).toBe(10);
  });

  it("caps the combined total across files at maxTotal by default (50)", () => {
    const artifacts = Array.from({ length: 10 }, (_, i) => artifact(`f${i}.json`, docWithNLeaves(10)));
    const plan = planMutations(artifacts);
    // 10 files * 10 leaves each = 100 eligible leaves, well under any single file's maxPerFile(10) cap,
    // so the binding constraint here is maxTotal.
    expect(plan.length).toBe(50);
  });

  it("respects custom maxPerFile/maxTotal overrides", () => {
    const plan = planMutations([artifact("big.json", docWithNLeaves(100))], { maxPerFile: 3, maxTotal: 3 });
    expect(plan.length).toBe(3);
  });

  it("makes truncation discoverable via planMutationsWithStats — the pre-truncation eligible count exceeds what was taken", () => {
    const stats = planMutationsWithStats([artifact("big.json", docWithNLeaves(100))]);
    expect(stats.mutations.length).toBe(10); // maxPerFile default
    expect(stats.eligibleLeafCounts["big.json"]).toBe(100); // the true count, not silently lost
    expect(stats.truncatedTotal).toBe(true);
  });

  it("reports no truncation when everything eligible fit under the caps", () => {
    const stats = planMutationsWithStats([artifact("small.json", { a: 1, b: 2 })]);
    expect(stats.mutations.length).toBe(2);
    expect(stats.eligibleLeafCounts["small.json"]).toBe(2);
    expect(stats.truncatedTotal).toBe(false);
  });
});

describe("planMutations — determinism", () => {
  it("produces the same plan, in the same order, across repeated calls on the same input", () => {
    const artifacts = [artifact("a.json", { z: 1, a: 2, nested: { y: "s", x: true } }), artifact("b.json", { rows: [{ n: 1 }, { n: 2 }] })];
    const first = planMutations(artifacts);
    const second = planMutations(JSON.parse(JSON.stringify(artifacts))); // fresh objects, same content
    expect(second).toEqual(first);
  });
});

describe("applyMutation", () => {
  it("round-trips a top-level leaf: the mutated leaf changes, nothing else does", () => {
    const doc = { count: 42, other: { untouched: "value" }, list: [1, 2, 3] };
    const body = JSON.stringify(doc);
    const m: Mutation = { file: "out.json", path: "count", before: 42, after: 43, label: "count: 42 -> 43" };
    const mutated = JSON.parse(applyMutation(body, m));
    expect(mutated.count).toBe(43);
    expect(mutated.other).toEqual(doc.other);
    expect(mutated.list).toEqual(doc.list);
  });

  it("round-trips a nested/array leaf found by planMutations itself", () => {
    const doc = { totals: { revenue: 100 }, rows: [{ currency: "usd" }, { currency: "eur" }] };
    const body = JSON.stringify(doc);
    const plan = planMutations([{ path: "out.json", body }]);
    const target = plan.find((m) => m.path === "rows.1.currency")!;
    expect(target).toBeDefined();

    const mutated = JSON.parse(applyMutation(body, target));
    expect(mutated.rows[1].currency).toBe("__MUTATED__");
    // Everything else, deep-equal to the original.
    expect(mutated.rows[0]).toEqual(doc.rows[0]);
    expect(mutated.totals).toEqual(doc.totals);
  });

  it("does not mutate its input string's underlying document — body is parsed fresh, not shared", () => {
    const body = JSON.stringify({ n: 1 });
    const m: Mutation = { file: "out.json", path: "n", before: 1, after: 2, label: "n: 1 -> 2" };
    applyMutation(body, m);
    expect(JSON.parse(body)).toEqual({ n: 1 }); // original text object untouched
  });
});

describe("planMutations — real cassette", () => {
  it("runs against examples/replays/example-pdf-skill.cassette.json without throwing, and the result is explainable", () => {
    const cassettePath = join(__dirname, "..", "examples", "replays", "example-pdf-skill.cassette.json");
    const cassette = JSON.parse(readFileSync(cassettePath, "utf8"));
    const artifacts: { path: string; body: string }[] = cassette.artifacts;
    expect(Array.isArray(artifacts)).toBe(true);
    expect(artifacts.length).toBeGreaterThan(0);

    // Inspect the real shape: some artifacts are `truncated: true` and body-less (e.g. an upload) —
    // the planner must skip those, not throw on a missing/undefined body.
    const bodyless = artifacts.filter((a) => typeof (a as unknown as { body?: unknown }).body !== "string");
    expect(bodyless.length).toBeGreaterThan(0); // sanity: this cassette really does exercise that path

    let plan: Mutation[] = [];
    expect(() => {
      plan = planMutations(artifacts);
    }).not.toThrow();

    // None of this cassette's artifacts are `.json` (notes.txt, outputs/actions.md, uploads/report.pdf),
    // so an EMPTY plan is the right answer here — not a bug, a correct "nothing perturbable" result.
    // The assertion is on the reason, not just the emptiness: every artifact fails the .json-path gate.
    expect(artifacts.every((a) => !a.path.toLowerCase().endsWith(".json"))).toBe(true);
    expect(plan).toEqual([]);
  });
});

// `--mutate` is diagnostic and exits 0 either way, so the empty-plan message is the ONE output a
// reader is likely to misread as "the feature is broken". Every cassette in this repo's own example
// corpus takes this path, so a terse line was actively misleading — each distinct cause needs a
// distinct, actionable message.
describe("explainNoMutations — the empty plan says WHY", () => {
  it("distinguishes 'no JSON artifacts at all' and names what a suitable scenario looks like", () => {
    const m = explainNoMutations([{ path: "outputs/report.md" }], []);
    expect(m).toMatch(/none of them \.json/);
    expect(m, "must tell the reader what to do, not just what is missing").toMatch(/JSON deliverable/);
  });

  it("reports the artifact count so an EMPTY manifest is distinguishable from a wrong-type one", () => {
    expect(explainNoMutations([], [])).toMatch(/records 0 artifact\(s\)/);
    expect(explainNoMutations([{ path: "a.md" }, { path: "b.txt" }], [])).toMatch(/records 2 artifact\(s\)/);
  });

  it("maps each truncationReason to its own remedy — the reasons are NOT interchangeable", () => {
    const size = explainNoMutations([{ path: "outputs/r.json", truncated: true, truncationReason: "size" }], []);
    expect(size).toMatch(/--max-artifact-bytes/); // actionable: re-record bigger

    const input = explainNoMutations([{ path: "uploads/x.json", truncated: true, truncationReason: "input" }], []);
    expect(input).toMatch(/deliberately never inlined/); // NOT actionable: by design, don't chase it
    expect(input, "an upload must not suggest raising the byte cap").not.toMatch(/--max-artifact-bytes/);
  });

  it("lists every distinct reason when a cassette mixes them, without duplicates", () => {
    const m = explainNoMutations(
      [
        { path: "a.json", truncationReason: "size" },
        { path: "b.json", truncationReason: "readonly" },
        { path: "c.json", truncationReason: "size" },
      ],
      [],
    );
    expect(m).toMatch(/size/);
    expect(m).toMatch(/readonly/);
    expect(m.match(/over the body cap/g) ?? []).toHaveLength(1); // deduped
  });

  it("separates 'body present but no perturbable leaf' from 'no body' — different fixes", () => {
    const m = explainNoMutations([{ path: "outputs/e.json" }], [{ path: "outputs/e.json", body: "{}" }]);
    expect(m).toMatch(/parsed, but none contains a perturbable leaf/);
    expect(m, "the body IS inlined here, so a truncation remedy would mislead").not.toMatch(/inlined body/);
  });

  it("never claims a reason it wasn't given", () => {
    expect(explainNoMutations([{ path: "a.json" }], [])).toMatch(/unrecorded reason/);
  });
});

// `truncatedTotal` cannot say WHICH cap bound — despite the name, mutate.ts sets it for per-file
// truncation too. The distinction is the whole point of the message: the per-file cap is checked BEFORE
// the total, so with a handful of artifacts the total is never reached and advising "--mutate-max-total"
// would be advice that changes nothing. This is what a consumer read as "50 of your 50 fields are
// unguarded" when 50 was a sample.
describe("summarizeMutationPlan", () => {
  const doc = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, i + 1]));
  const art = (path: string, n: number) => ({ path, body: JSON.stringify(doc(n)) });

  it("reports no truncation when everything fit", () => {
    const s = summarizeMutationPlan(planMutationsWithStats([art("a.json", 3)]));
    expect(s.truncatedBy).toBeNull();
    expect(s.sampled).toBe(3);
    expect(s.eligible).toBe(3);
  });

  it("attributes truncation to the per-file cap when the total was never reached", () => {
    // 3 files x 10 taken = 30 sampled, well under the 50 total — only the per-file cap bound.
    const s = summarizeMutationPlan(planMutationsWithStats([art("a.json", 40), art("b.json", 40), art("c.json", 40)]));
    expect(s.sampled).toBe(30);
    expect(s.eligible).toBe(120);
    expect(s.truncatedBy).toBe("per-file");
    expect(s.filesAtPerFileCap).toBe(3);
  });

  it("attributes to the total cap when it is reached, since raising per-file alone would not help", () => {
    const arts = Array.from({ length: 10 }, (_, i) => art(`f${i}.json`, 40));
    const s = summarizeMutationPlan(planMutationsWithStats(arts));
    expect(s.sampled).toBe(50); // 10 files x 10 = 100 wanted, total cap bit first
    expect(s.truncatedBy).toBe("total");
  });

  it("carries the caps in effect so a message can name the flag that raises them", () => {
    const s = summarizeMutationPlan(planMutationsWithStats([art("a.json", 3)]));
    expect(s.caps).toEqual({ perFile: 10, total: 50 });
  });

  it("reflects overridden caps rather than the defaults", () => {
    const s = summarizeMutationPlan(planMutationsWithStats([art("a.json", 9)], { maxPerFile: 2, maxTotal: 4 }), {
      maxPerFile: 2,
      maxTotal: 4,
    });
    expect(s.caps).toEqual({ perFile: 2, total: 4 });
    expect(s.sampled).toBe(2);
  });
});

// The planner is unit-tested above, but the SENTENCE a human reads was not covered anywhere — and the
// sentence is what went wrong in the field. "50/50 perturbation(s) CAUGHT BY NOTHING" parses as "50 of
// your 50 fields are unguarded"; 50 was a sample cap. A consumer aggregated twenty such lines into
// "1,020 perturbations, 0 caught" and came one step from reporting that their assertions verified
// nothing. These assert the emitted text, spawning the built CLI on a synthetic cassette (token-free).
describe("replay --mutate — the report is self-describing", () => {
  const CLI = resolve("dist/cli.js");
  const can = existsSync(CLI);
  const base = JSON.parse(readFileSync(resolve("examples/replays/example-pdf-skill.cassette.json"), "utf8"));

  /** A cassette carrying `files` JSON artifacts of `leaves` perturbable values each. */
  function cassetteWith(dir: string, files: number, leaves: number): string {
    const c = JSON.parse(JSON.stringify(base));
    c.artifacts = Array.from({ length: files }, (_, f) => {
      const body = JSON.stringify(Object.fromEntries(Array.from({ length: leaves }, (_, i) => [`k${i}`, i + 1])));
      return { path: `outputs/a${f}.json`, bytes: body.length, sha256: createHash("sha256").update(body).digest("hex"), body };
    });
    c.scenario.assert = [{ result: "success" }];
    const p = join(dir, "m.cassette.json");
    writeFileSync(p, JSON.stringify(c));
    return p;
  }

  const replay = (file: string, extra: string[] = []) =>
    spawnSync("node", [CLI, "replay", file, "--mutate", ...extra], { encoding: "utf8" });

  it.skipIf(!can)("names the eligible total and the per-file cap when per-file truncates", () => {
    const p = cassetteWith(mkdtempSync(join(tmpdir(), "mut-")), 3, 40);
    const out = replay(p).stdout + replay(p).stderr;
    expect(out).toMatch(/sampled 30 of 120 eligible/);
    expect(out).toMatch(/per-file cap 10 reached on 3 file\(s\)/);
    // The bare ratio must no longer stand alone as if it were the whole corpus.
    expect(out).toMatch(/30\/30 sampled perturbation/);
  });

  it.skipIf(!can)("adds no cap parenthetical when nothing was truncated", () => {
    const p = cassetteWith(mkdtempSync(join(tmpdir(), "mut-")), 1, 3);
    const out = replay(p).stdout + replay(p).stderr;
    expect(out).toMatch(/\[mutate\]/);
    expect(out).not.toMatch(/eligible value\(s\)/);
    expect(out).not.toMatch(/cap \d+ reached/);
  });

  it.skipIf(!can)("surfaces the coverage on the JSON envelope so it need not be scraped from text", () => {
    const p = cassetteWith(mkdtempSync(join(tmpdir(), "mut-")), 3, 40);
    const r = replay(p, ["--output-format", "json"]);
    const m = JSON.parse(r.stdout).results[0].mutation;
    expect(m.sampled).toBe(30);
    expect(m.eligible).toBe(120);
    expect(m.truncatedBy).toBe("per-file");
    expect(m.caps).toEqual({ perFile: 10, total: 50 });
    expect(m.uncaught).toHaveLength(30);
  });
});

// A dedicated matcher: analyze-skill's is module-private, is a FILESYSTEM expander rather than a string
// matcher, accepts only `dir/*.md`-shaped inputs, and is case-insensitive — all wrong here. Artifact
// paths are recorded strings, compared case-sensitively.
describe("matchesAnyGlob", () => {
  it("matches a literal path", () => {
    expect(matchesAnyGlob("outputs/a.json", ["outputs/a.json"])).toBe(true);
  });

  it("`*` stays within one segment", () => {
    expect(matchesAnyGlob("outputs/a.json", ["outputs/*.json"])).toBe(true);
    expect(matchesAnyGlob("outputs/deep/a.json", ["outputs/*.json"])).toBe(false);
  });

  it("`**` crosses segments — the shape needed to scope a whole subtree", () => {
    expect(matchesAnyGlob("handoff/run-1/state.json", ["handoff/**"])).toBe(true);
    expect(matchesAnyGlob("outputs/report.json", ["handoff/**"])).toBe(false);
  });

  it("is case-SENSITIVE (artifact paths are recorded strings, not filenames to be guessed at)", () => {
    expect(matchesAnyGlob("Outputs/a.json", ["outputs/*.json"])).toBe(false);
  });

  it("is true when any pattern matches, false for an empty pattern list", () => {
    expect(matchesAnyGlob("outputs/a.json", ["nope/**", "outputs/**"])).toBe(true);
    expect(matchesAnyGlob("outputs/a.json", [])).toBe(false);
  });

  it("treats regex metacharacters in a pattern as literals", () => {
    expect(matchesAnyGlob("outputs/a+b.json", ["outputs/a+b.json"])).toBe(true);
    expect(matchesAnyGlob("outputs/axb.json", ["outputs/a+b.json"])).toBe(false);
  });
});

// The reporter's corpus was dominated by per-run `handoff/` internals nobody should assert on, so the
// signal about delivered artifacts was buried in noise it would be WRONG to act on. Scoping turns the
// number into a work-list; the caps then bind on what survived, which is the point.
describe("replay --mutate — scoping and cap overrides", () => {
  const CLI = resolve("dist/cli.js");
  const can = existsSync(CLI);
  const base = JSON.parse(readFileSync(resolve("examples/replays/example-pdf-skill.cassette.json"), "utf8"));

  function cassette(dir: string, paths: string[], leaves: number): string {
    const c = JSON.parse(JSON.stringify(base));
    c.artifacts = paths.map((p) => {
      const body = JSON.stringify(Object.fromEntries(Array.from({ length: leaves }, (_, i) => [`k${i}`, i + 1])));
      return { path: p, bytes: body.length, sha256: createHash("sha256").update(body).digest("hex"), body };
    });
    c.scenario.assert = [{ result: "success" }];
    const f = join(dir, "s.cassette.json");
    writeFileSync(f, JSON.stringify(c));
    return f;
  }
  const json = (file: string, extra: string[]) =>
    JSON.parse(spawnSync("node", [CLI, "replay", file, "--mutate", "--output-format", "json", ...extra], { encoding: "utf8" }).stdout)
      .results[0].mutation;

  const paths = ["outputs/report.json", "handoff/run-1/state.json", "handoff/run-2/state.json"];

  it.skipIf(!can)("--mutate-exclude drops a whole subtree from the sample AND from the eligible count", () => {
    const f = cassette(mkdtempSync(join(tmpdir(), "sc-")), paths, 40);
    const m = json(f, ["--mutate-exclude", "handoff/**"]);
    expect(m.sampled).toBe(10); // one surviving file, per-file cap
    expect(m.eligible).toBe(40); // the excluded files are not counted as "missed" — they were out of scope
    expect(m.uncaught.every((u: string) => u.startsWith("outputs/"))).toBe(true);
  });

  it.skipIf(!can)("--mutate-include restricts to matching paths", () => {
    const f = cassette(mkdtempSync(join(tmpdir(), "sc-")), paths, 40);
    expect(json(f, ["--mutate-include", "outputs/**"]).eligible).toBe(40);
  });

  it.skipIf(!can)("exclude wins over include", () => {
    const f = cassette(mkdtempSync(join(tmpdir(), "sc-")), paths, 40);
    const m = json(f, ["--mutate-include", "**", "--mutate-exclude", "handoff/**"]);
    expect(m.eligible).toBe(40);
  });

  it.skipIf(!can)("repeated --mutate-exclude honours EVERY occurrence, not just the last", () => {
    const f = cassette(mkdtempSync(join(tmpdir(), "sc-")), paths, 40);
    const m = json(f, ["--mutate-exclude", "handoff/run-1/**", "--mutate-exclude", "handoff/run-2/**"]);
    expect(m.eligible).toBe(40); // both patterns applied; only outputs/ survives
  });

  it.skipIf(!can)("--mutate-max-per-file raises the cap that actually binds", () => {
    const f = cassette(mkdtempSync(join(tmpdir(), "sc-")), ["outputs/a.json"], 40);
    expect(json(f, []).sampled).toBe(10);
    expect(json(f, ["--mutate-max-per-file", "25"]).sampled).toBe(25);
    // Raising only the total cannot help while per-file binds — the trap the report now names.
    expect(json(f, ["--mutate-max-total", "500"]).sampled).toBe(10);
  });

  it.skipIf(!can)("the scoping flags require --mutate rather than silently doing nothing", () => {
    const f = cassette(mkdtempSync(join(tmpdir(), "sc-")), paths, 3);
    const r = spawnSync("node", [CLI, "replay", f, "--mutate-exclude", "handoff/**"], { encoding: "utf8" });
    expect(r.status).toBe(2);
    expect(r.stdout + r.stderr).toMatch(/require\(s\) --mutate/);
  });
});
