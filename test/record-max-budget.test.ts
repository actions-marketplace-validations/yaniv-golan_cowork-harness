import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { batchBudgetTracker } from "../src/run/budget.js";

// `record --max-budget-usd` — the paid path's cost cap. `record` is the widest-blast-radius spend in the
// CLI (dir batch + --rerecord-stale + --concurrency up to 8) and shipped with no cap at all until 1.15.0.
//
// Everything here is TOKEN-FREE: the refusal fires BEFORE any agent spawn (that is the whole point of a
// pre-flight), and the degradation paths are pure history lookups. Nothing below performs live inference.
const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), "rec-budget-runs-"));
}
function tmpWork() {
  return mkdtempSync(join(tmpdir(), "rec-budget-work-"));
}

/** Seed a priced run so `scenarioCostHistory` has something to refuse against. Mirrors the shape
 *  test/cli-stats.test.ts seeds; `stats --reindex` turns it into index.jsonl rows. */
function seedRun(root: string, scenario: string, runId: string, costUsd: number) {
  const dir = join(root, scenario, runId);
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
      cost: { usd: costUsd },
    }),
  );
}

function cli(args: string[], root: string) {
  const r = spawnSync("node", [CLI, ...args], { encoding: "utf8", env: { ...process.env, COWORK_HARNESS_RUNS_DIR: root } });
  return { code: r.status, out: r.stdout, err: r.stderr, all: r.stdout + r.stderr };
}

function scenarioYaml(name: string): string {
  return `name: ${name}\nprompt: "do the thing"\nfidelity: protocol\nassert:\n  - result: success\n`;
}

describe.skipIf(!can)("record --max-budget-usd — flag surface", () => {
  it("appears in the usage line (a flag nobody can discover is not a feature)", () => {
    const r = cli(["record"], tmpRoot());
    expect(r.all).toMatch(/--max-budget-usd/);
  });

  it("rejects a non-positive value as usage (exit 2)", () => {
    const work = tmpWork();
    writeFileSync(join(work, "s.yaml"), scenarioYaml("s"));
    for (const bad of ["0", "-1", "abc"]) {
      const r = cli(["record", join(work, "s.yaml"), "--max-budget-usd", bad], tmpRoot());
      expect(r.code, `value ${bad}`).toBe(2);
      expect(r.all).toMatch(/requires a positive number/);
    }
  });
});

describe.skipIf(!can)("record --max-budget-usd — single scenario", () => {
  it("REFUSES before spending when this scenario's own history exceeds the cap", () => {
    const root = tmpRoot();
    const work = tmpWork();
    seedRun(root, "pricey", "local_1", 0.5);
    cli(["stats", "--reindex"], root);
    writeFileSync(join(work, "pricey.yaml"), scenarioYaml("pricey"));
    const r = cli(["record", join(work, "pricey.yaml"), "--max-budget-usd", "0.1"], root);
    expect(r.all).toMatch(/refused before spending/);
    expect(r.all).toMatch(/has cost up to \$0\.5000/);
    expect(r.code).not.toBe(0);
  });

  it("PROCEEDS past the gate when history is under the cap (the refusal is not unconditional)", () => {
    const root = tmpRoot();
    const work = tmpWork();
    seedRun(root, "cheap", "local_1", 0.01);
    cli(["stats", "--reindex"], root);
    writeFileSync(join(work, "cheap.yaml"), scenarioYaml("cheap"));
    // --dry-run stops before any spawn; reaching the dry-run report proves the gate let it through.
    const r = cli(["record", join(work, "cheap.yaml"), "--max-budget-usd", "5", "--dry-run"], root);
    expect(r.all).not.toMatch(/refused before spending/);
    expect(r.all).toMatch(/record --dry-run/);
    expect(r.code).toBe(0);
  });

  it("degrades LOUDLY (warn + proceed UNCAPPED) when the scenario has never been priced", () => {
    const work = tmpWork();
    writeFileSync(join(work, "fresh.yaml"), scenarioYaml("fresh"));
    const r = cli(["record", join(work, "fresh.yaml"), "--max-budget-usd", "5", "--dry-run"], tmpRoot());
    expect(r.all).toMatch(/no priced run history/);
    expect(r.all).toMatch(/UNCAPPED/);
    expect(r.code).toBe(0);
  });
});

describe.skipIf(!can)("record --max-budget-usd — batch semantics are CUMULATIVE", () => {
  it("refuses on the SUM across the batch even when no single scenario exceeds the cap", () => {
    const root = tmpRoot();
    const work = tmpWork();
    // Neither is over $0.30 alone; together they are $0.36. A per-scenario cap would let this through —
    // which is exactly the hole the flag was requested to close (a 16-run re-record batch).
    for (const [name, cost] of [
      ["a", 0.18],
      ["b", 0.18],
    ] as const) {
      seedRun(root, name, "local_1", cost);
      writeFileSync(join(work, `${name}.yaml`), scenarioYaml(name));
    }
    cli(["stats", "--reindex"], root);
    const r = cli(["record", work, "--max-budget-usd", "0.3", "--dry-run"], root);
    expect(r.all).toMatch(/refused before spending/);
    expect(r.all).toMatch(/batch of 2 scenario\(s\)/);
    expect(r.code).not.toBe(0);
  });

  it("names the unpriced scenarios and calls the estimate a LOWER BOUND (never silently treats them as free)", () => {
    const root = tmpRoot();
    const work = tmpWork();
    seedRun(root, "priced", "local_1", 0.01);
    cli(["stats", "--reindex"], root);
    writeFileSync(join(work, "priced.yaml"), scenarioYaml("priced"));
    writeFileSync(join(work, "unpriced.yaml"), scenarioYaml("unpriced"));
    const r = cli(["record", work, "--max-budget-usd", "5", "--dry-run"], root);
    expect(r.all).toMatch(/1\/2 scenario\(s\) have no priced run history/);
    expect(r.all).toMatch(/unpriced/);
    expect(r.all).toMatch(/LOWER BOUND/);
  });
});

describe.skipIf(!can)("record --max-budget-usd — the gate is part of --dry-run, not skipped by it", () => {
  it("--dry-run refuses identically (a preview that reports clean and is then refused is a false preview)", () => {
    const root = tmpRoot();
    const work = tmpWork();
    seedRun(root, "pricey", "local_1", 0.5);
    cli(["stats", "--reindex"], root);
    writeFileSync(join(work, "pricey.yaml"), scenarioYaml("pricey"));
    const dry = cli(["record", join(work, "pricey.yaml"), "--max-budget-usd", "0.1", "--dry-run"], root);
    const real = cli(["record", join(work, "pricey.yaml"), "--max-budget-usd", "0.1"], root);
    expect(dry.all).toMatch(/refused before spending/);
    expect(real.all).toMatch(/refused before spending/);
    expect(dry.code).toBe(real.code); // the preview's verdict IS the real verdict
  });
});

describe.skipIf(!can)("record --max-budget-usd — concurrency honesty", () => {
  it("warns in the PREVIEW that the running-total stop is disabled above --concurrency 1", () => {
    const root = tmpRoot();
    const work = tmpWork();
    seedRun(root, "a", "local_1", 0.01);
    cli(["stats", "--reindex"], root);
    writeFileSync(join(work, "a.yaml"), scenarioYaml("a"));
    const r = cli(["record", work, "--max-budget-usd", "5", "--concurrency", "2", "--dry-run"], root);
    expect(r.all).toMatch(/running-total stop is DISABLED/);
    expect(r.all).toMatch(/--concurrency 1 for a running total/);
  });

  it("does NOT emit the caveat at --concurrency 1, where the running total does apply", () => {
    const root = tmpRoot();
    const work = tmpWork();
    seedRun(root, "a", "local_1", 0.01);
    cli(["stats", "--reindex"], root);
    writeFileSync(join(work, "a.yaml"), scenarioYaml("a"));
    const r = cli(["record", work, "--max-budget-usd", "5", "--concurrency", "1", "--dry-run"], root);
    expect(r.all).not.toMatch(/running-total stop is DISABLED/);
  });
});

// The running-total abort is unit-tested directly: driving it through the CLI would require real paid
// recordings, which is precisely what the flag exists to avoid.
describe("batchBudgetTracker — the running total", () => {
  it("stops once the cap is reached, but only when enforcement is on (--concurrency 1)", () => {
    const on = batchBudgetTracker(0.1, true);
    on.add(0.04);
    expect(on.stopped()).toBe(false);
    on.add(0.07); // 0.11 >= 0.10
    expect(on.stopped()).toBe(true);

    const off = batchBudgetTracker(0.1, false);
    off.add(0.04);
    off.add(0.07);
    expect(off.stopped()).toBe(false); // above concurrency 1 the total is not enforceable
  });

  it("never stops when no cap was given", () => {
    const none = batchBudgetTracker(undefined, true);
    none.add(999);
    expect(none.stopped()).toBe(false);
  });

  it("DISABLES the running total (loudly, once) when a run reports no cost telemetry", () => {
    const warnings: string[] = [];
    const t = batchBudgetTracker(0.1, true, (s) => warnings.push(s));
    // The priced runs alone total $0.18, well OVER the $0.10 cap — so if a missing-telemetry run were
    // silently treated as $0 and counting simply continued, stopped() would flip true. It must not:
    // once a run's cost is unknown the running total is no longer a fact about this batch, and a cap
    // enforced on an incomplete sum is a false guarantee. (These amounts are load-bearing — with both
    // adds under the cap the assertion passes either way and the test proves nothing.)
    t.add(0.09);
    t.add(undefined); // telemetry missing → the running total can no longer be trusted
    t.add(0.09);
    expect(t.stopped()).toBe(false);
    expect(warnings).toHaveLength(1); // once per batch, not once per unpriced run
    expect(warnings[0]).toMatch(/unenforceable/);
  });

  it("summary fires only when the cap actually cut the batch short", () => {
    const t = batchBudgetTracker(0.1, true);
    t.add(0.2);
    expect(t.summary(3, 10)).toMatch(/stopped the record batch early \(3\/10 recorded/);
    expect(t.summary(10, 10)).toBeUndefined(); // nothing was skipped
    const clean = batchBudgetTracker(0.1, true);
    clean.add(0.01);
    expect(clean.summary(3, 10)).toBeUndefined(); // cap never reached
  });
});
