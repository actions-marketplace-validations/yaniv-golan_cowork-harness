import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

// `record --dry-run` is the DOCUMENTED token-free validation path — SKILL.md ("to check that a scenario
// loads without spending"), docs/scenario.md ("runs the real loader"), docs/cassette.md ("preview + REAL
// loader check"), README ("the token-free way to check whether a scenario still loads"). A consumer who
// follows that advice — including in a CI "scenario load check" step — must not be told a scenario is
// fine and then have the real `record` refuse it.
//
// That principle is already written down three lines from the code under test, on the budget gate:
// "A dry run whose whole job is 'tell me what this would do before I spend' must not report clean and
// then be refused for real — that is a false preview, and it is free to check." Both scenario-level
// refusals below are free to check (pure functions over the parsed scenario), so the same rule applies.
//
// Reported by a founder-skills consumer against 1.20.0-unreleased: the contradiction refusal shipped on
// the execution path only, and `record --dry-run` — the one non-opt-in place they'd hit it — exited 0.
const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);

function tmpWork() {
  return mkdtempSync(join(tmpdir(), "rec-dry-preflight-"));
}
function cli(args: string[]) {
  const r = spawnSync("node", [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, COWORK_HARNESS_RUNS_DIR: mkdtempSync(join(tmpdir(), "rec-dry-runs-")) },
  });
  return { code: r.status, all: (r.stdout ?? "") + (r.stderr ?? "") };
}

const CONTRADICTORY = (name: string) =>
  `name: ${name}\nprompt: hi\nfidelity: protocol\nassert:\n  - questions_count_max: 0\n  - gate_answer_count_min: 1\n`;
const PROMPT_POLICY = (name: string) =>
  `name: ${name}\nprompt: hi\nfidelity: protocol\non_unanswered: prompt\nassert:\n  - result: success\n`;
const CLEAN = (name: string) => `name: ${name}\nprompt: hi\nfidelity: protocol\nassert:\n  - result: success\n`;

describe.skipIf(!can)("record --dry-run — scenario-level refusals (no false preview)", () => {
  it("refuses a statically unsatisfiable scenario, single file", () => {
    const w = tmpWork();
    writeFileSync(join(w, "c.yaml"), CONTRADICTORY("contra"));
    const r = cli(["record", join(w, "c.yaml"), "--dry-run"]);
    expect(r.code, "dry-run must not green a scenario the real record refuses").not.toBe(0);
    expect(r.all).toMatch(/no run can satisfy/);
  });

  it("agrees with the real record path — both refuse the same scenario", () => {
    // The precedence claim in one assertion: if these ever disagree, the dry run is a false preview
    // again, whichever direction it drifts.
    const w = tmpWork();
    writeFileSync(join(w, "c.yaml"), CONTRADICTORY("contra"));
    const dry = cli(["record", join(w, "c.yaml"), "--dry-run"]);
    const real = cli(["record", join(w, "c.yaml"), "--out", join(w, "c.cassette.json")]);
    expect(dry.code).not.toBe(0);
    expect(real.code).not.toBe(0);
    expect(existsSync(join(w, "c.cassette.json")), "the real path must not have written a cassette").toBe(false);
  });

  it("still greens a clean scenario (the refusal is not a blanket non-zero)", () => {
    const w = tmpWork();
    writeFileSync(join(w, "ok.yaml"), CLEAN("ok"));
    expect(cli(["record", join(w, "ok.yaml"), "--dry-run"]).code).toBe(0);
  });

  it("reports EVERY offender in a batch, not just the first", () => {
    // A dry run over N scenarios exists to learn about all N in one pass. Aborting at the first bad file
    // turns a 24-scenario preflight into 24 sequential round trips — the failure mode the consumer hit
    // from the other side (a contradiction in #18 aborting a paid batch mid-flight).
    const w = tmpWork();
    writeFileSync(join(w, "a-contra.yaml"), CONTRADICTORY("a-contra"));
    writeFileSync(join(w, "b-ok.yaml"), CLEAN("b-ok"));
    writeFileSync(join(w, "c-contra.yaml"), CONTRADICTORY("c-contra"));
    const r = cli(["record", w, "--dry-run"]);
    expect(r.code).not.toBe(0);
    expect(r.all, "first offender missing").toMatch(/a-contra/);
    expect(r.all, "second offender missing — the batch stopped early").toMatch(/c-contra/);
  });

  it("greens a batch where every scenario is clean", () => {
    const w = tmpWork();
    writeFileSync(join(w, "a.yaml"), CLEAN("a"));
    writeFileSync(join(w, "b.yaml"), CLEAN("b"));
    expect(cli(["record", w, "--dry-run"]).code).toBe(0);
  });

  it("refuses on_unanswered: prompt in a BATCH dry-run too", () => {
    // The single-file dry-run arm has always run promptPolicyRejection; the batch arm never did, so the
    // same scenario greened in a directory and was refused per-scenario by the real record. Fixing the
    // contradiction gap without this one would leave an arbitrary split: batch dry-run checking one
    // scenario-level refusal but not its sibling.
    const w = tmpWork();
    writeFileSync(join(w, "p.yaml"), PROMPT_POLICY("prompty"));
    const r = cli(["record", w, "--dry-run"]);
    expect(r.code).not.toBe(0);
    expect(r.all).toMatch(/on_unanswered: prompt/);
  });

  it("--quiet suppresses the preview but never a refusal", () => {
    // --quiet's contract is "silent on success, loud on failure" (docs/cassette.md). A muted refusal
    // would make the CI-shaped invocation the one that hides the finding.
    const w = tmpWork();
    writeFileSync(join(w, "c.yaml"), CONTRADICTORY("contra"));
    const r = cli(["record", w, "--dry-run", "--quiet"]);
    expect(r.code).not.toBe(0);
    expect(r.all).toMatch(/no run can satisfy/);
  });
});

describe.skipIf(!can)("record --dry-run — batch cost estimate", () => {
  // The estimate was computed and then discarded unless it happened to exceed a cap, so learning the
  // number required bisecting --max-budget-usd. It is a pure history lookup — free to report.
  it("reports the batch cost estimate without requiring --max-budget-usd", () => {
    const w = tmpWork();
    writeFileSync(join(w, "a.yaml"), CLEAN("a"));
    writeFileSync(join(w, "b.yaml"), CLEAN("b"));
    const r = cli(["record", w, "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.all, "no cost estimate on the passing path").toMatch(/estimate/i);
  });

  it("carries the estimate in the JSON payload", () => {
    const w = tmpWork();
    writeFileSync(join(w, "a.yaml"), CLEAN("a"));
    const r = cli(["record", w, "--dry-run", "--output-format", "json"]);
    const payload = JSON.parse(r.all.slice(r.all.indexOf("{"), r.all.lastIndexOf("}") + 1));
    const body = payload.results?.[0] ?? payload;
    expect(body, "estimatedCostUsd missing from the dry-run payload").toHaveProperty("estimatedCostUsd");
    expect(body).toHaveProperty("unpricedScenarios");
  });

  it("says the estimate is a LOWER BOUND when scenarios have no priced history", () => {
    // An estimate summed over partially-unpriced history must never read as authoritative — an
    // unqualified "$0.00" on a fresh corpus is worse than no number at all.
    const w = tmpWork();
    writeFileSync(join(w, "a.yaml"), CLEAN("never-run-before"));
    const r = cli(["record", w, "--dry-run"]);
    expect(r.all).toMatch(/lower bound/i);
  });
});
