import { describe, it, expect } from "vitest";
import { buildStats, type RunIndexRow } from "../src/run/run-index.js";

// The tier axis is the OTHER thing that makes two runs incomparable (the first is skill generation):
// container (Docker) and hostloop (native) differ in pass rate, cost, and duration. These tests pin
// distinctTiers/tiers on StatsSummary and `--group-by fidelity`, keyed on effectiveFidelity ?? fidelity
// — a TOTAL key (fidelity is required on every row), so unlike skillHash grouping NOTHING is ever
// excluded and there is deliberately no tierlessRuns counter.

const base = {
  v: 1 as const,
  command: "run" as const,
  scenario: "skill-csv-metrics",
  slug: "skill-csv-metrics",
  baseline: "1.24012.9",
  fidelity: "container",
  result: "success" as const,
  pass: true,
  signals: [],
  partial: false,
  nonDeterministic: false,
  git: { branch: "main", sha: "abc" },
};

function runRow(opts: {
  runId: string;
  fidelity?: string;
  effectiveFidelity?: string;
  pass?: boolean;
  costUsd?: number;
  ts?: string;
}): RunIndexRow {
  const { runId, fidelity = "container", effectiveFidelity, pass = true, costUsd = 0.2, ts = "2026-07-31T09:00:00.000Z" } = opts;
  return {
    ...base,
    ts,
    runId,
    outDir: `/runs/skill-csv-metrics/${runId}`,
    fidelity,
    effectiveFidelity,
    pass,
    costUsd,
    durationMs: 5000,
  } as RunIndexRow;
}

// Live numbers from sess-crit-98c4c6f8 — the same pin test/stats-critique-cost-total.test.ts carries.
const TASK = 0.17084700000000003;
const REFLECTION = 0.19672499999999998;
const EVALUATORS = 0.6911825;
const CRITIQUE_TOTAL = 1.0587545;

/** The three rows one critique writes, all sharing one tier. NOTE: no effectiveFidelity — this is the
 *  reindex-from-critique-report shape (run-index.ts leaves it undefined there), so these rows ALSO
 *  exercise the ?? fidelity fallback on every path that touches them. */
function critiqueRows(opts: { runId: string; tier?: string; ts?: string }): RunIndexRow[] {
  const { runId, tier = "hostloop", ts = "2026-07-31T09:42:48.000Z" } = opts;
  const outDir = `/runs/skill-csv-metrics/${runId}`;
  return [
    { ...base, ts, runId, outDir, fidelity: tier, turn: 1, critiqueRole: "task", costUsd: TASK, durationMs: 6000 },
    { ...base, ts, runId, outDir, fidelity: tier, turn: 2, critiqueRole: "reflection", costUsd: REFLECTION, durationMs: 11100 },
    { ...base, ts, runId, outDir, fidelity: tier, critiqueRole: "rollup", costUsd: EVALUATORS, critiqueTotalUsd: CRITIQUE_TOTAL },
  ] as RunIndexRow[];
}

const only = (rows: RunIndexRow[], filters: Parameters<typeof buildStats>[1] = {}) => {
  const s = buildStats(rows, filters).summaries;
  expect(s).toHaveLength(1);
  return s[0];
};

describe("distinctTiers + tiers on StatsSummary", () => {
  it("T1: counts effective tiers — 2 for container+hostloop, 1 for uniform, sorted names", () => {
    const mixed = [runRow({ runId: "a", effectiveFidelity: "container" }), runRow({ runId: "b", effectiveFidelity: "hostloop" })];
    const s = only(mixed);
    expect(s.distinctTiers).toBe(2);
    expect(s.tiers).toEqual(["container", "hostloop"]);
    expect(only([runRow({ runId: "a" }), runRow({ runId: "b" })]).distinctTiers).toBe(1);
  });

  it("T1b: a cowork-requested row counts as the tier that RAN, not as a third 'cowork' tier", () => {
    const rows = [
      runRow({ runId: "a", fidelity: "cowork", effectiveFidelity: "hostloop" }),
      runRow({ runId: "b", fidelity: "hostloop", effectiveFidelity: "hostloop" }),
    ];
    expect(only(rows).distinctTiers).toBe(1);
  });

  it("T7: computed over the POST-window rows, so the warning can never disagree with the aggregate", () => {
    const rows = [
      runRow({ runId: "old", effectiveFidelity: "container", ts: "2026-07-28T06:00:00.000Z" }),
      runRow({ runId: "new", effectiveFidelity: "hostloop", ts: "2026-07-31T09:00:00.000Z" }),
    ];
    const s = only(rows, { last: 1 });
    expect(s.runs).toBe(1);
    expect(s.distinctTiers).toBe(1);
  });
});

describe("--group-by fidelity", () => {
  it("T3: splits a mixed scenario into per-tier summaries with the right runs each", () => {
    const rows = [
      runRow({ runId: "a", effectiveFidelity: "container" }),
      runRow({ runId: "b", effectiveFidelity: "container" }),
      runRow({ runId: "c", effectiveFidelity: "hostloop" }),
    ];
    const s = buildStats(rows, { groupBy: "fidelity" }).summaries;
    expect(s).toHaveLength(2);
    expect(Object.fromEntries(s.map((x) => [x.fidelity, x.runs]))).toEqual({ container: 2, hostloop: 1 });
    // Always 1 under the split — that is the whole point of it.
    expect(s.every((x) => x.distinctTiers === 1)).toBe(true);
  });

  it("T4: a row lacking effectiveFidelity falls back to fidelity and is GROUPED, never dropped", () => {
    const rows = [runRow({ runId: "a", fidelity: "hostloop" }), runRow({ runId: "b", effectiveFidelity: "hostloop" })];
    const { summaries, hashlessRuns } = buildStats(rows, { groupBy: "fidelity" });
    expect(summaries).toHaveLength(1);
    expect(summaries[0].runs).toBe(2);
    // The key is TOTAL: nothing is ever excluded under this grouping — and no tierlessRuns field exists.
    expect(hashlessRuns).toBe(0);
  });

  // NOTE: give this one an effectiveFidelity-stamped fixture. The shared `critiqueRows` helper does
  // NOT set effectiveFidelity, so an unmodified T5 exercises the SAME fallback path as T6 and the two
  // tests become identical inputs under different names — a distinction that reads as coverage but is
  // not. Stamp `effectiveFidelity: "hostloop"` on all three rows here; leave T6 unstamped.
  it("T5: a critique's 3 rows stay in ONE group and its totalUsd survives intact", () => {
    const s = only(critiqueRows({ runId: "sess-crit-1" }), { groupBy: "fidelity" });
    expect(s.fidelity).toBe("hostloop");
    expect(s.totalUsd).toBeCloseTo(CRITIQUE_TOTAL, 10);
  });

  it("T6: a reindexed critique (no effectiveFidelity on ANY row) still groups whole via the fallback", () => {
    // The reindex-from-critique-report path leaves effectiveFidelity undefined; the ?? fidelity
    // fallback must keep all three rows — turns AND the spend roll-up — in one group.
    const s = only(critiqueRows({ runId: "sess-crit-2" }), { groupBy: "fidelity" });
    expect(s.runs).toBe(2); // the roll-up is spend, not a run
    expect(s.totalUsd).toBeCloseTo(CRITIQUE_TOTAL, 10);
  });

  it("T6b: KNOWN EDGE (documented, unreachable today) — a roll-up keying to a tier with no run rows is silently dropped from every total", () => {
    // Under --group-by fidelity the tier key is never undefined, so a spend roll-up always keys on its
    // OWN tier; if that ever disagrees with its turns' tier it lands in a phantom group and
    // `groups.get(key)?.spend.push(r)` silently drops it. Unreachable today: critique resolves `cowork`
    // at parse time and every writer stamps both fields consistently. This pin exists so that if a
    // change ever makes the disagreement reachable, THIS test fails and forces an honesty channel
    // (a counter or a note) before the silent loss ships. If you are here because it failed: do not
    // just update the expectation.
    const rows = critiqueRows({ runId: "sess-crit-3" });
    rows[2] = { ...rows[2], fidelity: "container" } as RunIndexRow; // divergent roll-up
    const s = buildStats(rows, { groupBy: "fidelity" }).summaries;
    expect(s).toHaveLength(1); // no phantom "container" group is minted
    expect(s[0].fidelity).toBe("hostloop");
    expect(s[0].totalUsd).toBeCloseTo(TASK + REFLECTION, 10); // the evaluator spend is GONE — the documented hazard
  });
});
