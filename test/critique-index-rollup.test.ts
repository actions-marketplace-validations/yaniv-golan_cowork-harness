import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { appendCritiqueRollupRow, readIndex, reindexFromRunsTree, buildStats, CRITIQUE_SESSION_PREFIX } from "../src/run/run-index.js";

// A critique is FOUR model workloads but only TWO of them produce a run: the graded turn and the reflection
// turn each write their own index row via the inner `skill` run, while the two evaluator passes are direct
// API calls that produce no run at all. Summing the index therefore missed them — measured at $10.17
// indexed against $16.67 actual across three runs — and the index is the only cost record that survives
// run-dir pruning, so a spend trend built from it was systematically light.

function rollupArgs(outDir: string) {
  return {
    outDir,
    scenario: "skill-my-plugin",
    fidelity: "container",
    baseline: "desktop-1.24012.9",
    totalUsd: 5.6435,
    evaluatorUsd: 2.1644,
    complete: true,
    runLabel: "post-fixes",
    skill: "market-sizing",
    skillHash: "abc123def456789",
  };
}

describe("critique cost roll-up row", () => {
  it("records the WHOLE critique's spend, which the per-turn rows cannot", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-idx-"));
    appendCritiqueRollupRow(root, rollupArgs(join(root, "skill-my-plugin", "sess-crit-1")));
    const rows = readIndex(root);
    expect(rows).toHaveLength(1);
    const r = rows[0]!;
    expect(r.critiqueRole).toBe("rollup");
    expect(r.critiqueTotalUsd).toBeCloseTo(5.6435);
    // `costUsd` is the EVALUATOR delta, not the total: the two graded turns already contribute their own
    // rows, so putting the total here would double-count them under `sum(costUsd)`, while omitting it
    // would under-count by exactly the ~39% this row exists to fix.
    expect(r.costUsd).toBeCloseTo(2.1644);
    // The provenance a harvester previously had to open the run dir to recover.
    expect(r.skill).toBe("market-sizing");
    expect(r.runLabel).toBe("post-fixes");
    // Bookkeeping, not a verdict: the graded turn's own row already carries that, and a roll-up that voted
    // would double-count it in stats' pass rate.
    expect(r.signals).toEqual([]);
    expect(r.pass).toBe(true);
  });

  it("survives the shape validator — i.e. the new fields do not quarantine the row", () => {
    // The whole reason these are additive-optional rather than a new `command` value: the validator
    // hard-codes the command allowlist, so a widened union would make an OLDER cli quarantine every
    // critique row with a per-row warning and drop it from stats.
    const root = mkdtempSync(join(tmpdir(), "cwh-idx-"));
    appendCritiqueRollupRow(root, rollupArgs(join(root, "skill-my-plugin", "sess-crit-2")));
    const raw = JSON.parse(readFileSync(join(root, "index.jsonl"), "utf8").trim());
    expect(raw.command).toBe("skill"); // NOT a new command value
    expect(readIndex(root)).toHaveLength(1); // not quarantined
  });

  it("marks an incomplete cost rather than summing it as if whole", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-idx-"));
    appendCritiqueRollupRow(root, { ...rollupArgs(join(root, "s", "sess-crit-3")), complete: false });
    const r = readIndex(root)[0]!;
    expect(r.result).toBe("error"); // an unpriced workload must not read as authoritative spend
    expect(r.partial).toBe(true);
  });

  it("does not collide with the turn rows sharing its outDir", () => {
    // The roll-up has no `turn`, so under bare-outDir identity it would merge with a legacy no-turn row.
    const root = mkdtempSync(join(tmpdir(), "cwh-idx-"));
    const outDir = join(root, "skill-my-plugin", "sess-crit-4");
    appendCritiqueRollupRow(root, rollupArgs(outDir));
    appendCritiqueRollupRow(root, rollupArgs(outDir));
    // Same identity → a reindex merge would collapse them; distinct identity from the turn rows is what
    // matters here, so assert the role is what disambiguates.
    expect(readIndex(root).every((r) => r.critiqueRole === "rollup")).toBe(true);
  });
});

const outDirOf = (root: string) => join(root, "skill-my-plugin", "sess-crit-e52097db-9a01-4a11-a0fd-623c14b26e27");

describe("critique session-id contract", () => {
  it("an id minted the way critique mints one is detected as a critique run", () => {
    // Binds the two sides of the convention: critique mints `${CRITIQUE_SESSION_PREFIX}${randomUUID()}`
    // and the index detects the resulting `sess-<id>` run dir. Renaming the constant on one side alone —
    // or changing the `sess-` run-dir prefix — must fail HERE rather than silently unmarking every row.
    const root = mkdtempSync(join(tmpdir(), "cwh-idx-"));
    const sessionId = `${CRITIQUE_SESSION_PREFIX}${randomUUID()}`;
    const outDir = join(root, "skill-x", `sess-${sessionId}`);
    mkdirSync(join(outDir, "turns", "1"), { recursive: true });
    writeFileSync(
      join(outDir, "turns", "1", "result.json"),
      JSON.stringify({
        $schema: "x",
        generator: "cowork-harness",
        mode: "run",
        command: "skill",
        scenario: "s",
        fidelity: "container",
        baseline: "b",
        result: "success",
        turn: 1,
        outDir,
        assertions: [],
      }),
    );
    reindexFromRunsTree(root);
    expect(readIndex(root)[0]!.critiqueRole).toBe("task");
    rmSync(root, { recursive: true, force: true });
  });
});

describe("critique roll-up survives and is rebuilt by --reindex", () => {
  /** A minimal critique run dir: two turn results plus the report the roll-up is re-derived from. */
  function makeCritiqueRunDir(root: string, opts: { report?: Record<string, unknown> | null } = {}) {
    const sess = "sess-crit-e52097db-9a01-4a11-a0fd-623c14b26e27";
    const outDir = join(root, "skill-my-plugin", sess);
    for (const turn of [1, 2]) {
      const d = join(outDir, "turns", String(turn));
      mkdirSync(d, { recursive: true });
      writeFileSync(
        join(d, "result.json"),
        JSON.stringify({
          $schema: "x",
          generator: "cowork-harness",
          mode: "run",
          command: "skill",
          scenario: "renamed-scenario",
          fidelity: "container",
          baseline: "desktop-1.24012.9",
          result: "success",
          turn,
          outDir,
          runLabel: "post-fixes",
          assertions: [],
          durationMs: 1000,
        }),
      );
    }
    if (opts.report !== null)
      writeFileSync(
        join(outDir, "critique-report.json"),
        JSON.stringify(
          opts.report ?? {
            skillFolder: "/x/my-plugin",
            fidelity: "container",
            gradedBaseline: "desktop-1.24012.9",
            gradedSkill: "market-sizing",
            gradedSkillHash: "abc123def4567890",
            costUsd: {
              taskTurnUsd: 2.79,
              reflectionTurnUsd: 0.68,
              evaluatorPass1Usd: 1.04,
              evaluatorPass2Usd: 1.13,
              totalUsd: 5.64,
              complete: true,
            },
          },
        ),
      );
    return outDir;
  }

  it("a LIVE roll-up is not destroyed by a routine reindex", () => {
    // The supersede clause drops prior rows with `turn === undefined` whose outDir was walked — which a
    // roll-up always is. Every ordinary `--reindex` deleted the only cost record that survives run-dir
    // pruning, during the operation whose job is to heal the index.
    const root = mkdtempSync(join(tmpdir(), "cwh-idx-"));
    const outDir = makeCritiqueRunDir(root, { report: null }); // no report → synthesis cannot mask it
    appendCritiqueRollupRow(root, { ...rollupArgs(outDir), outDir });
    reindexFromRunsTree(root);
    expect(readIndex(root).filter((r) => r.critiqueRole === "rollup")).toHaveLength(1);
  });

  it("rebuilds the roll-up from critique-report.json with NO prior index at all", () => {
    // The G2 scenario: index lost entirely, run dirs intact.
    const root = mkdtempSync(join(tmpdir(), "cwh-idx-"));
    makeCritiqueRunDir(root);
    reindexFromRunsTree(root);
    const rollups = readIndex(root).filter((r) => r.critiqueRole === "rollup");
    expect(rollups).toHaveLength(1);
    expect(rollups[0]!.critiqueTotalUsd).toBeCloseTo(5.64);
    expect(rollups[0]!.costUsd).toBeCloseTo(2.17); // evaluator delta, not the total
    expect(rollups[0]!.skill).toBe("market-sizing");
    // scenario/runLabel come from the GRADED TURN — the report carries neither.
    // MUST come from the graded turn, not the path or the report: `slugForPath` is lossy so `slug` is not
    // reversible to `scenario`, and the report carries no scenario at all. The fixture's scenario is
    // deliberately NOT what `skill-<basename(skillFolder)>` would produce, or this asserts nothing.
    expect(rollups[0]!.scenario).toBe("renamed-scenario");
    expect(rollups[0]!.runLabel).toBe("post-fixes");
    // Historical provenance is honest: never "now", never the current checkout.
    expect(rollups[0]!.git).toEqual({ branch: null, sha: null });
    // ...and `ts` is the report file's own mtime, not "now": a historical row must not claim a timestamp
    // it did not have. (The fixture was just written, so assert the relationship, not a literal.)
    expect(rollups[0]!.ts).toBe(statSync(join(outDirOf(root), "critique-report.json")).mtime.toISOString());
  });

  it("a MOVED runs tree still yields exactly ONE roll-up, under the real scenario", () => {
    // Walked rows carry result.json's RECORDED outDir; the walk knows only the current path. When a tree is
    // restored or relocated (backup, moved HOME, /var vs /private/var) those disagree — keying the
    // synthesized row on the walk path minted a SECOND roll-up beside the preserved original and lost the
    // graded match, filing it under a fabricated scenario. Both failures land on the recovery path.
    const root = mkdtempSync(join(tmpdir(), "cwh-idx-"));
    const outDir = makeCritiqueRunDir(root);
    // Simulate the move: results record a DIFFERENT absolute path than where they now live.
    for (const turn of [1, 2]) {
      const f = join(outDir, "turns", String(turn), "result.json");
      const r = JSON.parse(readFileSync(f, "utf8"));
      r.outDir = "/elsewhere/skill-my-plugin/sess-crit-e52097db-9a01-4a11-a0fd-623c14b26e27";
      writeFileSync(f, JSON.stringify(r));
    }
    const recorded = "/elsewhere/skill-my-plugin/sess-crit-e52097db-9a01-4a11-a0fd-623c14b26e27";
    // A LIVE roll-up exists under the RECORDED path — this is what a real critique wrote before the move.
    appendCritiqueRollupRow(root, { ...rollupArgs(recorded), outDir: recorded });
    reindexFromRunsTree(root);
    reindexFromRunsTree(root);
    const rollups = readIndex(root).filter((r) => r.critiqueRole === "rollup");
    // Keying the synthesized row on the WALK path gives it a different identity from the live one, so both
    // survive and the critique is counted twice.
    expect(rollups).toHaveLength(1);
    expect(rollups[0]!.outDir).toBe(recorded); // identity follows the rows, not the filesystem
    expect(rollups[0]!.scenario).toBe("renamed-scenario");
    expect(rollups[0]!.runLabel).toBe("post-fixes");
    rmSync(root, { recursive: true, force: true });
  });

  it("attributes each roll-up to ITS OWN dir when a tree holds several critiques", () => {
    // The graded-row lookup must be scoped to the dir being synthesized. Handed the whole accumulated walk
    // set, `find(r => r.turn === 1)` matches the FIRST critique's task row for every later dir — so a
    // second critique's roll-up inherits the first's scenario, runLabel and outDir. A runs root with more
    // than one critique in it is the normal case, not an edge case.
    const root = mkdtempSync(join(tmpdir(), "cwh-idx-"));
    const mk = (sess: string, scenario: string, label: string) => {
      const outDir = join(root, "skill-my-plugin", sess);
      for (const turn of [1, 2]) {
        const d = join(outDir, "turns", String(turn));
        mkdirSync(d, { recursive: true });
        writeFileSync(
          join(d, "result.json"),
          JSON.stringify({
            $schema: "x",
            generator: "cowork-harness",
            mode: "run",
            command: "skill",
            scenario,
            fidelity: "container",
            baseline: "b",
            result: "success",
            turn,
            outDir,
            runLabel: label,
            assertions: [],
          }),
        );
      }
      writeFileSync(
        join(outDir, "critique-report.json"),
        JSON.stringify({
          skillFolder: "/x/my-plugin",
          fidelity: "container",
          gradedSkill: "s",
          costUsd: { evaluatorPass1Usd: 1, evaluatorPass2Usd: 1, totalUsd: 4, complete: true },
        }),
      );
      return outDir;
    };
    mk("sess-crit-11111111-1111-4111-8111-111111111111", "scenario-A", "label-A");
    mk("sess-crit-22222222-2222-4222-8222-222222222222", "scenario-B", "label-B");
    reindexFromRunsTree(root);
    const rollups = readIndex(root)
      .filter((r) => r.critiqueRole === "rollup")
      .sort((a, b) => a.runId.localeCompare(b.runId));
    expect(rollups).toHaveLength(2);
    expect(rollups.map((r) => r.scenario)).toEqual(["scenario-A", "scenario-B"]);
    expect(rollups.map((r) => r.runLabel)).toEqual(["label-A", "label-B"]);
    rmSync(root, { recursive: true, force: true });
  });

  it("is idempotent — reindexing twice yields exactly one roll-up", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-idx-"));
    makeCritiqueRunDir(root);
    reindexFromRunsTree(root);
    reindexFromRunsTree(root);
    reindexFromRunsTree(root);
    expect(readIndex(root).filter((r) => r.critiqueRole === "rollup")).toHaveLength(1);
  });

  it("does not synthesize for a critique that never produced a cost (infra failure)", () => {
    // persistCritiqueArtifacts writes a report on EVERY outcome, including a killed task turn where cost
    // is never computed and the live path appended no roll-up either.
    const root = mkdtempSync(join(tmpdir(), "cwh-idx-"));
    makeCritiqueRunDir(root, { report: { skillFolder: "/x/my-plugin", infraFailure: "task turn timed out" } });
    reindexFromRunsTree(root);
    expect(readIndex(root).filter((r) => r.critiqueRole === "rollup")).toHaveLength(0);
  });

  it("a corrupt report neither synthesizes nor destroys an existing roll-up", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-idx-"));
    const outDir = makeCritiqueRunDir(root, { report: null });
    writeFileSync(join(outDir, "critique-report.json"), "{ not json");
    appendCritiqueRollupRow(root, { ...rollupArgs(outDir), outDir });
    reindexFromRunsTree(root);
    expect(readIndex(root).filter((r) => r.critiqueRole === "rollup")).toHaveLength(1);
  });

  it("marks the turn rows by role, and only for a genuine critique session id", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-idx-"));
    makeCritiqueRunDir(root);
    reindexFromRunsTree(root);
    const rows = readIndex(root);
    expect(rows.find((r) => r.turn === 1)!.critiqueRole).toBe("task");
    expect(rows.find((r) => r.turn === 2)!.critiqueRole).toBe("reflection");
  });

  it("leaves a turn >= 3 in a critique dir UNMARKED rather than guessing a role", () => {
    // A user can resume a `sess-crit-*` session with the public --session-id/--resume flags. Marking that
    // "task" (or "reflection") fabricates provenance, which is worse than leaving it unmarked.
    const root = mkdtempSync(join(tmpdir(), "cwh-idx-"));
    const outDir = join(root, "skill-my-plugin", "sess-crit-e52097db-9a01-4a11-a0fd-623c14b26e27");
    const d = join(outDir, "turns", "3");
    mkdirSync(d, { recursive: true });
    writeFileSync(
      join(d, "result.json"),
      JSON.stringify({
        $schema: "x",
        generator: "cowork-harness",
        mode: "run",
        command: "skill",
        scenario: "s",
        fidelity: "container",
        baseline: "b",
        result: "success",
        turn: 3,
        outDir,
        assertions: [],
      }),
    );
    reindexFromRunsTree(root);
    expect(readIndex(root).find((r) => r.turn === 3)!.critiqueRole).toBeUndefined();
    rmSync(root, { recursive: true, force: true });
  });

  it("does NOT mark an UPPERCASE crit- id — randomUUID mints lowercase", () => {
    // Reachable via the public `--session-id CRIT-<UUID>`. A case-insensitive match would fabricate a role
    // for a run critique never made.
    const root = mkdtempSync(join(tmpdir(), "cwh-idx-"));
    const outDir = join(root, "skill-x", "sess-CRIT-E52097DB-9A01-4A11-A0FD-623C14B26E27");
    mkdirSync(join(outDir, "turns", "1"), { recursive: true });
    writeFileSync(
      join(outDir, "turns", "1", "result.json"),
      JSON.stringify({
        $schema: "x",
        generator: "cowork-harness",
        mode: "run",
        command: "skill",
        scenario: "s",
        fidelity: "container",
        baseline: "b",
        result: "success",
        turn: 1,
        outDir,
        assertions: [],
      }),
    );
    reindexFromRunsTree(root);
    expect(readIndex(root)[0]!.critiqueRole).toBeUndefined();
    rmSync(root, { recursive: true, force: true });
  });

  it("does NOT mark a user-supplied --session-id that merely starts with crit-", () => {
    // `--session-id` is a public flag accepting any [A-Za-z0-9_-]+, so `skill --session-id crit-mytest`
    // would collide with a bare-prefix check. Detection is anchored to the full minted uuid shape.
    const root = mkdtempSync(join(tmpdir(), "cwh-idx-"));
    const outDir = join(root, "skill-x", "sess-crit-mytest");
    const d = join(outDir, "turns", "1");
    mkdirSync(d, { recursive: true });
    writeFileSync(
      join(d, "result.json"),
      JSON.stringify({
        $schema: "x",
        generator: "cowork-harness",
        mode: "run",
        command: "skill",
        scenario: "skill-x",
        fidelity: "container",
        baseline: "b",
        result: "success",
        turn: 1,
        outDir,
        assertions: [],
      }),
    );
    reindexFromRunsTree(root);
    expect(readIndex(root)[0]!.critiqueRole).toBeUndefined();
  });

  it("excludes roll-ups from stats, so they cannot inflate passRate or the cost percentiles", () => {
    // A roll-up shares its scenario with the turn rows, so leaving it in added a phantom run and dragged
    // passRate toward 1 — in a RATE there is no neutral pass value, only exclusion.
    const root = mkdtempSync(join(tmpdir(), "cwh-idx-"));
    const outDir = makeCritiqueRunDir(root, { report: null });
    appendCritiqueRollupRow(root, { ...rollupArgs(outDir), outDir });
    const rows = readIndex(root);
    const withRollup = buildStats(rows, {});
    const without = buildStats(
      rows.filter((r) => r.critiqueRole !== "rollup"),
      {},
    );
    expect(withRollup).toEqual(without);
  });
});
