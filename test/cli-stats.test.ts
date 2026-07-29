import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

// CLI-level coverage for `stats` (E4). The pure aggregation logic (buildStats/reindexFromRunsTree/etc) is
// unit-tested in test/run-index.test.ts; this covers command wiring — arg parsing, exit codes,
// --output-format, --reindex against a real synthetic runs tree.
const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);

function runsRoot() {
  return mkdtempSync(join(tmpdir(), "cli-stats-runs-"));
}

function seedRun(root: string, scenario: string, runId: string, over: Record<string, unknown> = {}) {
  const dir = join(root, scenario, runId);
  // `turns/1/` — where the writer actually puts a result. This fixture wrote it at the run-dir root
  // because that is what the writer did when it was written; nothing reads a root result.json now, so
  // leaving it would have made every assertion in this file vacuous rather than failing loudly.
  mkdirSync(join(dir, "turns", "1"), { recursive: true });
  writeFileSync(
    join(dir, "turns", "1", "result.json"),
    JSON.stringify({
      scenario,
      fidelity: "container",
      baseline: "desktop-1.18286.0",
      result: "success",
      decisions: [],
      egress: [],
      assertions: [],
      outDir: dir,
      ...over,
    }),
  );
}

function run(args: string[], root: string) {
  const r = spawnSync("node", [CLI, ...args], { encoding: "utf8", env: { ...process.env, COWORK_HARNESS_RUNS_DIR: root } });
  return { code: r.status, out: r.stdout + r.stderr };
}

describe.skipIf(!can)("cli: stats (E4)", () => {
  it("--reindex rebuilds the index from a synthetic runs tree, then a plain call reads it back", () => {
    const root = runsRoot();
    seedRun(root, "my-scenario", "local_111", { durationMs: 5000, cost: { usd: 0.02 } });
    seedRun(root, "my-scenario", "local_222", { result: "error", durationMs: 3000 });
    const reindexed = run(["stats", "--reindex"], root);
    expect(reindexed.code).toBe(0);
    expect(reindexed.out).toMatch(/reindexed 2 run/);

    const r = run(["stats"], root);
    expect(r.code).toBe(0);
    expect(r.out).toContain("my-scenario: 2 run(s), 50% pass");
  });

  it("--output-format json emits a structured envelope with per-scenario stats", () => {
    const root = runsRoot();
    seedRun(root, "s", "local_1", { cost: { usd: 0.1 } });
    run(["stats", "--reindex"], root);
    const r = run(["stats", "--output-format", "json"], root);
    expect(r.code).toBe(0);
    const line = r.out.split("\n").find((l) => l.trim().startsWith("{"));
    const envelope = JSON.parse(line!);
    expect(envelope).toMatchObject({ tool: "cowork-harness", command: "stats", ok: true });
    expect(envelope.stats).toEqual([expect.objectContaining({ scenario: "s", runs: 1, passRate: 1 })]);
  });

  it("filters by scenario (positional)", () => {
    const root = runsRoot();
    seedRun(root, "a", "local_1");
    seedRun(root, "b", "local_1");
    run(["stats", "--reindex"], root);
    const r = run(["stats", "a"], root);
    expect(r.out).toContain("a:");
    expect(r.out).not.toContain("b:");
  });

  it("reports 'no indexed runs' cleanly for an empty/fresh runs root, exit 0 (not an error)", () => {
    const root = runsRoot();
    const r = run(["stats"], root);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/no indexed runs/);
  });

  it("rejects an invalid --metric value", () => {
    const root = runsRoot();
    const r = run(["stats", "--metric", "bogus"], root);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/--metric must be one of/);
  });

  it("rejects a non-positive --last", () => {
    const root = runsRoot();
    const r = run(["stats", "--last", "0"], root);
    expect(r.code).toBe(2);
  });

  it("rejects more than one positional", () => {
    const root = runsRoot();
    const r = run(["stats", "a", "b"], root);
    expect(r.code).toBe(2);
  });

  it("rejects an unknown flag", () => {
    const root = runsRoot();
    const r = run(["stats", "--bogus"], root);
    expect(r.code).toBe(2);
  });

  it("`stats --help` prints usage and exits 0", () => {
    const root = runsRoot();
    const r = run(["stats", "--help"], root);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/usage: stats/);
  });

  it("--metric cost narrows the text line to just the cost view", () => {
    const root = runsRoot();
    seedRun(root, "s", "local_1", { cost: { usd: 0.05 } });
    run(["stats", "--reindex"], root);
    const r = run(["stats", "--metric", "cost"], root);
    expect(r.out).toContain("cost p50=");
    expect(r.out).not.toContain("duration p50=");
  });

  it("--metric cache-tokens / model-cost narrow the text line to the modelUsage-derived views", () => {
    const root = runsRoot();
    seedRun(root, "s", "local_1", { modelUsage: { "claude-opus-4-8": { cacheReadInputTokens: 1000, costUSD: 0.5 } } });
    run(["stats", "--reindex"], root);
    const cacheTokens = run(["stats", "--metric", "cache-tokens"], root);
    expect(cacheTokens.out).toContain("cache-read-tokens p50=");
    expect(cacheTokens.out).not.toContain("model-cost p50=");
    const modelCost = run(["stats", "--metric", "model-cost"], root);
    expect(modelCost.out).toContain("model-cost p50=");
  });

  it("--reindex is a true rebuild — a run dir removed from disk between reindexes drops out", () => {
    const root = runsRoot();
    seedRun(root, "s", "local_1");
    seedRun(root, "s", "local_2");
    run(["stats", "--reindex"], root);
    expect(run(["stats", "--output-format", "json"], root).out).toContain('"runs":2');
    // seed a FRESH tree with only one run (simulating the other having been pruned before a re-reindex)
    const root2 = runsRoot();
    seedRun(root2, "s", "local_1");
    run(["stats", "--reindex"], root2);
    expect(run(["stats", "--output-format", "json"], root2).out).toContain('"runs":1');
  });

  it("--reindex reports a symlinked run dir as skipped, not silently dropped", () => {
    const root = runsRoot();
    seedRun(root, "s", "local_1"); // one legitimate run, so `written` isn't zero either
    // A symlinked `<runId>` dir must be rejected outright — never followed — per reindexFromRunsTree's
    // containment guard (src/run/run-index.ts). Point it at a real, unrelated result.json elsewhere so a
    // regression that DID follow the symlink would silently index it instead of erroring loudly.
    const elsewhere = mkdtempSync(join(tmpdir(), "cli-stats-elsewhere-"));
    seedRun(elsewhere, "elsewhere-scenario", "real_run");
    mkdirSync(join(root, "s"), { recursive: true });
    symlinkSync(join(elsewhere, "elsewhere-scenario", "real_run"), join(root, "s", "local_symlinked"));

    const r = run(["stats", "--reindex"], root);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/reindexed 1 run/);
    expect(r.out).toContain("skipped — symlinked run dir/result.json rejected");
    expect(r.out).not.toContain("elsewhere-scenario"); // the symlinked target was never indexed
  });
});

describe.skipIf(!can)("cli: stats — generation queries", () => {
  const GEN1 = "5d2d482d80d3";
  const GEN2 = "8fc999c77cdf";

  /** Two generations of one scenario, plus a second scenario, seeded through the real reindex path. */
  function seedTwoGenerations() {
    const root = runsRoot();
    seedRun(root, "s", "local_1", { fingerprint: { skillHash: GEN1 + "aaaa" }, runLabel: "gen-1" });
    seedRun(root, "s", "local_2", { fingerprint: { skillHash: GEN2 + "bbbb" }, runLabel: "gen-2" });
    run(["stats", "--reindex"], root);
    return root;
  }

  it("warns when one aggregate spans more than one skill generation, and names both remedies", () => {
    const r = run(["stats", "s"], seedTwoGenerations());
    expect(r.code).toBe(0);
    expect(r.out).toContain("::warning::");
    expect(r.out).toContain("spans 2 skill generations");
    expect(r.out).toContain("--group-by skill-hash");
  });

  it("--group-by skill-hash splits the aggregate and silences the warning", () => {
    const r = run(["stats", "s", "--group-by", "skill-hash"], seedTwoGenerations());
    expect(r.code).toBe(0);
    expect(r.out).not.toContain("::warning::");
    expect(r.out).toContain(`skillHash=${GEN1}`);
    expect(r.out).toContain(`skillHash=${GEN2}`);
  });

  it("--skill-hash narrows to one generation", () => {
    const r = run(["stats", "s", "--skill-hash", GEN2], seedTwoGenerations());
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/1 run\(s\)/);
    expect(r.out).not.toContain("::warning::");
  });

  // THE parsing trap: `positionals` skips a flag's value only for flags it was told about, so a new
  // value-flag missing from that list makes its VALUE parse as the scenario positional — `stats
  // --skill-hash abc` would silently become `stats abc` and match nothing. Mutation-checked: removing
  // "--skill-hash" from the positionals list turns this green assertion red.
  it("a value-flag's value is never mistaken for the scenario positional", () => {
    const root = seedTwoGenerations();
    const r = run(["stats", "--skill-hash", GEN1, "s"], root);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^s.*1 run\(s\)/m);
    expect(r.out).not.toContain("no indexed runs match");
  });

  it("--label filters on the generation tag", () => {
    const r = run(["stats", "s", "--label", "gen-1"], seedTwoGenerations());
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/1 run\(s\)/);
  });

  it("rejects an unknown --group-by value with a usage error, not a silent fallback", () => {
    const r = run(["stats", "--group-by", "bogus"], runsRoot());
    expect(r.code).toBe(2);
    expect(r.out).toContain("--group-by must be one of scenario|skill-hash|label");
  });

  it("rejects a --skill-hash too short to identify a generation", () => {
    const r = run(["stats", "--skill-hash", "ab"], runsRoot());
    expect(r.code).toBe(2);
    expect(r.out).toContain("at least 6 characters");
  });

  it("the JSON envelope carries the new identity/diagnostic fields", () => {
    const r = run(["stats", "s", "--group-by", "skill-hash", "--output-format", "json"], seedTwoGenerations());
    expect(r.code).toBe(0);
    const envelope = JSON.parse(r.out.split("\n").find((l) => l.startsWith("{"))!);
    expect(envelope.hashlessRuns).toBe(0);
    expect(envelope.stats).toHaveLength(2);
    expect(envelope.stats.map((s: { skillHash: string }) => s.skillHash).sort()).toEqual([GEN1, GEN2].sort());
    expect(envelope.stats.every((s: { distinctSkillHashes: number }) => s.distinctSkillHashes === 1)).toBe(true);
  });

  it("the ::warning:: goes to stderr, so a JSON stdout envelope stays parseable", () => {
    const root = seedTwoGenerations();
    const r = spawnSync("node", [CLI, "stats", "s", "--output-format", "json"], {
      encoding: "utf8",
      env: { ...process.env, COWORK_HARNESS_RUNS_DIR: root },
    });
    expect(r.stderr).toContain("::warning::");
    expect(() => JSON.parse(r.stdout.trim())).not.toThrow();
  });

  // `--max-budget-usd` on a SINGLE run pre-flights against this same index — a single run has no live
  // cost signal to abort on, so history is the only thing available before the spend.
  it("refuses a single run BEFORE spending when the scenario's history exceeds the cap", () => {
    const root = runsRoot();
    seedRun(root, "pricey", "local_1", { cost: { usd: 3.5 } });
    run(["stats", "--reindex"], root);
    const d = mkdtempSync(join(tmpdir(), "cli-stats-budget-"));
    writeFileSync(join(d, "pricey.yaml"), "name: pricey\nprompt: hi\n");
    const r = spawnSync("node", [CLI, "run", join(d, "pricey.yaml"), "--max-budget-usd", "1.0"], {
      encoding: "utf8",
      env: { ...process.env, COWORK_HARNESS_RUNS_DIR: root },
    });
    expect(r.status).toBe(2);
    const out = r.stdout + r.stderr;
    expect(out).toContain("refused before spending");
    expect(out).toContain("$3.5000");
  });

  // The complement of the refusal, asserted on the PURE function so the test never has to start a real
  // run: history under the cap produces no refusal. (`preflightBudget` only refuses on `worst > cap`.)
  it("history comfortably under the cap yields a max below it — nothing to refuse", () => {
    const root = runsRoot();
    seedRun(root, "cheap", "local_1", { cost: { usd: 0.02 } });
    seedRun(root, "cheap", "local_2", { cost: { usd: 0.05 } });
    run(["stats", "--reindex"], root);
    const r = run(["stats", "cheap", "--metric", "cost"], root);
    expect(r.code).toBe(0);
    expect(r.out).toContain("$0.0"); // priced history exists, and its worst case is well under $1
  });

  it("counts and reports runs excluded from grouping for want of a skillHash", () => {
    const root = runsRoot();
    seedRun(root, "s", "local_1", { fingerprint: { skillHash: GEN1 + "aaaa" } });
    seedRun(root, "s", "local_2"); // no fingerprint at all — a chat-lane/no-skill run
    run(["stats", "--reindex"], root);
    const r = run(["stats", "s", "--group-by", "skill-hash"], root);
    expect(r.code).toBe(0);
    expect(r.out).toContain("1 run(s) excluded from grouping");
  });
});
