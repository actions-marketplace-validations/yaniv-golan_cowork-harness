import { describe, it, expect } from "vitest";
import { buildStats, scenarioCostHistory, budgetPreflight, type RunIndexRow } from "../src/run/run-index.js";

// `stats` used to price a critique at its TASK TURN alone.
//
// A critique writes three index rows whose costUsd values partition its spend DISJOINTLY — the two graded
// turns carry their own, and the roll-up's costUsd is the two evaluator passes ONLY, set that way so the
// sum is exact and double-counts nothing. But one predicate (`isAggregatable`) gated both "is this a run?"
// and "does this carry spend?", and roll-ups were dropped before any filter ran. Measured live on
// sess-crit-98c4c6f8: $0.1708 of an actual $1.0588 under --label (84% light), $0.368 unfiltered (65%).
//
// The numbers below ARE that live run, so these tests fail if the partition invariant is ever broken at
// the writer end too.

const TASK = 0.17084700000000003;
const REFLECTION = 0.19672499999999998;
const EVALUATORS = 0.6911825; // the roll-up's costUsd — evaluator passes only, NOT the whole critique
const CRITIQUE_TOTAL = 1.0587545; // == critiqueTotalUsd on the roll-up row

const base = {
  v: 1 as const,
  // The INNER command both graded turns ran, and what the roll-up records too — `critiqueRole` is what
  // distinguishes the three (run-index.ts:278).
  command: "skill" as const,
  scenario: "skill-csv-metrics",
  slug: "skill-csv-metrics",
  baseline: "1.24012.9",
  fidelity: "hostloop",
  result: "success" as const,
  pass: true,
  signals: [],
  partial: false,
  nonDeterministic: false,
  git: { branch: "main", sha: "abc" },
};

/** The three rows one critique writes. `runId` is the session identity all three share. */
function critiqueRows(opts: { runId: string; skillHash: string; label?: string; ts?: string }): RunIndexRow[] {
  const { runId, skillHash, label, ts = "2026-07-31T09:42:48.000Z" } = opts;
  const outDir = `/runs/skill-csv-metrics/${runId}`;
  return [
    { ...base, ts, runId, outDir, skillHash, runLabel: label, turn: 1, critiqueRole: "task", costUsd: TASK, durationMs: 6000 },
    // NOTE: no runLabel — --label is deliberately forwarded to turn 1 only.
    { ...base, ts, runId, outDir, skillHash, turn: 2, critiqueRole: "reflection", costUsd: REFLECTION, durationMs: 11100 },
    {
      ...base,
      ts,
      runId,
      outDir,
      skillHash,
      runLabel: label,
      critiqueRole: "rollup",
      costUsd: EVALUATORS,
      critiqueTotalUsd: CRITIQUE_TOTAL,
    },
  ] as RunIndexRow[];
}

function plainRun(opts: { runId: string; skillHash: string; costUsd?: number; ts?: string; label?: string }): RunIndexRow {
  const { runId, skillHash, costUsd = 0.184, ts = "2026-07-28T06:29:52.000Z", label } = opts;
  return {
    ...base,
    ts,
    runId,
    outDir: `/runs/skill-csv-metrics/${runId}`,
    skillHash,
    runLabel: label,
    costUsd,
    durationMs: 5600,
  } as RunIndexRow;
}

const only = (rows: RunIndexRow[], filters: Parameters<typeof buildStats>[1] = {}) => {
  const s = buildStats(rows, filters).summaries;
  expect(s).toHaveLength(1);
  return s[0];
};

describe("T1 — totalUsd equals the critique's true spend, exactly", () => {
  it("sums the disjoint partition back to critiqueTotalUsd", () => {
    const s = only(critiqueRows({ runId: "sess-crit-1", skillHash: "aae2d4642d95" }));
    expect(s.totalUsd).toBeCloseTo(CRITIQUE_TOTAL, 10);
    // The bug, stated as a number: the old behaviour returned exactly the two graded turns.
    expect(s.totalUsd).not.toBeCloseTo(TASK + REFLECTION, 6);
  });

  it("sums critique and plain runs together for a scenario that holds both", () => {
    const rows = [
      ...critiqueRows({ runId: "sess-crit-1", skillHash: "h1" }),
      plainRun({ runId: "local_1", skillHash: "h2", costUsd: 0.184 }),
    ];
    expect(only(rows).totalUsd).toBeCloseTo(CRITIQUE_TOTAL + 0.184, 10);
  });
});

describe("T2 — the roll-up stays OUT of every run-shaped statistic", () => {
  it("does not count as a run, and does not enter cost percentiles", () => {
    const s = only(critiqueRows({ runId: "sess-crit-1", skillHash: "h1" }));
    expect(s.runs).toBe(2); // task + reflection, NOT 3
    // p95 over [0.1708, 0.1967] must never reach the roll-up's 0.6912.
    expect(s.p95CostUsd).toBeLessThan(0.25);
    expect(s.p50DurationMs).toBeDefined(); // roll-up has no duration and must not create a 0
  });

  it("does not drag passRate — the reason roll-ups were excluded in the first place", () => {
    const rows = critiqueRows({ runId: "sess-crit-1", skillHash: "h1" });
    (rows[0] as { pass: boolean }).pass = false; // the graded turn failed
    const s = only(rows);
    expect(s.runs).toBe(2);
    expect(s.passRate).toBe(0.5); // 1 of 2 runs, NOT 2 of 3
  });
});

describe("T3 — the budget pre-flight is per-RUN and must not see roll-ups", () => {
  // The most important case here. `--max-budget-usd` refuses BEFORE spending, from this history. Feeding
  // it evaluator spend turns a working gate into a false refusal of runs nowhere near the cap.
  const rows = [
    ...critiqueRows({ runId: "sess-crit-1", skillHash: "h1" }),
    plainRun({ runId: "local_1", skillHash: "h2", costUsd: 0.1985 }),
  ];

  it("reports only run costs, never the roll-up's", () => {
    const history = scenarioCostHistory(rows, "skill-csv-metrics");
    expect(history.sort()).toEqual([TASK, REFLECTION, 0.1985].sort());
    expect(history).not.toContain(EVALUATORS);
    expect(Math.max(...history)).toBeCloseTo(0.1985, 6);
  });

  it("a $0.50 cap PROCEEDS — a run of this scenario costs ~$0.19", () => {
    const history = scenarioCostHistory(rows, "skill-csv-metrics");
    expect(budgetPreflight(history, 0.5).refuse).toBe(false);
    // Had the roll-up leaked in, `worst` would be $0.6912 and this would refuse.
    expect(budgetPreflight([...history, EVALUATORS], 0.5).refuse).toBe(true);
  });
});

describe("T4/T5 — session expansion completes a --label total without inflating the run count", () => {
  const rows = critiqueRows({ runId: "sess-crit-1", skillHash: "h1", label: "gen-a" });

  it("T4: the label-filtered total is exact, though turn 2 carries no label", () => {
    const s = only(rows, { label: "gen-a" });
    expect(s.totalUsd).toBeCloseTo(CRITIQUE_TOTAL, 10);
    expect(s.totalUsd).not.toBeCloseTo(TASK + EVALUATORS, 6); // the 19%-light answer without expansion
  });

  it("T5: the unlabelled reflection turn does NOT become a run in the labelled group", () => {
    // If it did, it would re-enter as a near-always-green run and inflate passRate — exactly what keeping
    // --label off turn 2 exists to prevent. Expansion must be cost-only.
    const s = only(rows, { label: "gen-a" });
    expect(s.runs).toBe(1);
    expect(s.p50CostUsd).toBeCloseTo(TASK, 10); // percentiles still over the ONE labelled run
  });

  it("T5b: same under --group-by label", () => {
    const s = only(rows, { groupBy: "label" });
    expect(s.runLabel).toBe("gen-a");
    expect(s.runs).toBe(1);
    expect(s.totalUsd).toBeCloseTo(CRITIQUE_TOTAL, 10);
  });
});

describe("T6 — expansion never re-admits a row excluded by a SCOPE filter", () => {
  it("respects --since even for a session sibling", () => {
    const rows = critiqueRows({ runId: "sess-crit-1", skillHash: "h1", label: "gen-a" });
    (rows[1] as { ts: string }).ts = "2026-07-01T00:00:00.000Z"; // reflection turn is OLD
    const s = only(rows, { label: "gen-a", since: "2026-07-30T00:00:00.000Z" });
    // task + roll-up only: the out-of-window sibling must stay out. "I don't want these rows at all"
    // outranks "this generation includes its own evaluator spend".
    expect(s.totalUsd).toBeCloseTo(TASK + EVALUATORS, 10);
  });

  it("respects --branch likewise", () => {
    const rows = critiqueRows({ runId: "sess-crit-1", skillHash: "h1", label: "gen-a" });
    (rows[1] as { git: { branch: string; sha: string } }).git = { branch: "other", sha: "z" };
    expect(only(rows, { label: "gen-a", branch: "main" }).totalUsd).toBeCloseTo(TASK + EVALUATORS, 10);
  });
});

describe("T7 — an unpriced row is flagged, never summed as 0", () => {
  it("counts it in unpricedRuns and leaves the total a floor", () => {
    const rows = critiqueRows({ runId: "sess-crit-1", skillHash: "h1" });
    delete (rows[1] as { costUsd?: number }).costUsd; // reflection turn has no cost telemetry
    const s = only(rows);
    expect(s.unpricedRuns).toBe(1);
    expect(s.totalUsd).toBeCloseTo(TASK + EVALUATORS, 10);
  });

  it("totalUsd is undefined — not 0 — when nothing in the group was priced", () => {
    const rows = critiqueRows({ runId: "sess-crit-1", skillHash: "h1" });
    for (const r of rows) delete (r as { costUsd?: number }).costUsd;
    const s = only(rows);
    expect(s.totalUsd).toBeUndefined(); // "$0.0000" would read as "this was free"
    expect(s.unpricedRuns).toBe(3);
  });
});

describe("T8 — --skill-hash needs no expansion (the roll-up carries the hash)", () => {
  it("is exact for the matched generation and excludes the other", () => {
    const rows = [
      ...critiqueRows({ runId: "sess-crit-1", skillHash: "aae2d4642d95" }),
      ...critiqueRows({ runId: "sess-crit-2", skillHash: "0f1022a4509a", ts: "2026-07-28T06:30:00.000Z" }),
    ];
    expect(only(rows, { skillHash: "aae2d4642d95" }).totalUsd).toBeCloseTo(CRITIQUE_TOTAL, 10);
    // and the A/B view splits them cleanly
    const groups = buildStats(rows, { groupBy: "skill-hash" }).summaries;
    expect(groups).toHaveLength(2);
    for (const g of groups) expect(g.totalUsd).toBeCloseTo(CRITIQUE_TOTAL, 10);
  });
});

describe("T9 — durability edges", () => {
  it("a pruned run dir still counts toward the total (the index is the durable history)", () => {
    const rows = critiqueRows({ runId: "sess-crit-1", skillHash: "h1" }); // outDir does not exist on disk
    const s = only(rows);
    expect(s.prunedRuns).toBeGreaterThan(0);
    expect(s.totalUsd).toBeCloseTo(CRITIQUE_TOTAL, 10);
  });

  it("--last windows spend BY SESSION, so the total describes the runs shown", () => {
    const rows = [
      ...critiqueRows({ runId: "sess-crit-old", skillHash: "h1", ts: "2026-07-01T00:00:00.000Z" }),
      ...critiqueRows({ runId: "sess-crit-new", skillHash: "h2", ts: "2026-07-31T00:00:00.000Z" }),
    ];
    // --last 2 keeps the newer session's two turns; the older session's evaluator cost must not linger.
    const s = only(rows, { last: 2 });
    expect(s.runs).toBe(2);
    expect(s.totalUsd).toBeCloseTo(CRITIQUE_TOTAL, 10);
  });
});
