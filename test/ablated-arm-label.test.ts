import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { buildRepeatRollup, armLabel } from "../src/run/repeat.js";
import type { RunResult } from "../src/types.js";

// `--ablate-skill --repeat 5` produces 5 CONTROL runs and zero treatment runs — correct behaviour for a
// single-arm flag, and the rollup summarized it as `repeat "<skill>": PASS — 5/5 passed (100%)` with no
// mention of which arm ran. A consumer read that as a completed A/B twice, producing 10 baseline runs
// and 0 treatment runs across two prompts (~$16) before noticing at analysis time.
//
// The fix is the LABEL, not a refusal. Refusing the combination would ban a legitimate measurement —
// "how variable is my no-skill baseline?" is a real question these flags compose correctly to answer —
// and the output was never dishonest, only unlabeled at the one line a human reads. (Contrast
// `--ablate-skill` + `--resume`, which IS refused in execute.ts: there ablation genuinely does not take
// effect, so `ablated: true` would be a lie. Different defect, different remedy.)

const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);

const base = {
  scenario: "s",
  fidelity: "container",
  baseline: "p",
  result: "success",
  decisions: [],
  egress: [],
  assertions: [{ assertion: {}, pass: true }],
  outDir: "runs/s/x",
} as unknown as RunResult;

const r = (over: Partial<RunResult>): RunResult => ({ ...base, ...over }) as RunResult;
const batch = (over: Partial<RunResult>, n: number) => Array.from({ length: n }, () => r(over));

describe("armLabel — which arm did this batch run?", () => {
  it("an all-ablated batch is named as the control arm", () => {
    expect(armLabel(buildRepeatRollup("s", 5, batch({ ablated: true }, 5)))).toBe(" [ABLATED — control arm]");
  });

  // The overwhelmingly common case must stay unlabeled: a tag on every batch is noise, and noise is
  // how the ablated tag would come to be ignored.
  it("a normal batch carries no tag at all", () => {
    expect(armLabel(buildRepeatRollup("s", 5, batch({}, 5)))).toBe("");
  });

  // No flag produces this today, but a resumed or hand-assembled run set could — and a batch that is
  // half control is not interpretable as either arm, so it must not read as either.
  it("a partially-ablated batch is called out as mixed, not silently rounded to one arm", () => {
    const mixed = [r({ ablated: true }), r({ ablated: true }), r({})];
    expect(armLabel(buildRepeatRollup("s", 3, mixed))).toBe(" [MIXED ARMS: 2/3 ablated]");
  });

  it("an empty batch gets no tag (nothing ran, so no arm to name)", () => {
    expect(armLabel(buildRepeatRollup("s", 5, []))).toBe("");
  });
});

describe.skipIf(!can)("the rollup verdict line names the arm", () => {
  // Rendering goes through the CLI's private formatter, so assert on armLabel's contract plus the
  // composition below; the line is `repeat "<s>": <verdict>[ARM] — n/m passed (p%)`.
  it("the label is positioned to read as part of the verdict, not a trailing note", () => {
    const roll = buildRepeatRollup("s", 2, batch({ ablated: true }, 2));
    const verdict = "PASS";
    const line = `repeat "${roll.scenario}": ${verdict}${armLabel(roll)} — ${roll.passes}/${roll.completed} passed`;
    expect(line).toBe('repeat "s": PASS [ABLATED — control arm] — 2/2 passed');
  });

  // The regression guard for the decision itself: this plan originally proposed REFUSING the
  // combination. If a future change reintroduces that refusal, this fails. `--dry-run` validates every
  // flag and exits 0 without spawning an agent, so a usage-level refusal would surface here.
  it("`--ablate-skill --repeat` is still accepted — the combination was NOT banned", () => {
    const d = mkdtempSync(join(tmpdir(), "arm-"));
    const raw = spawnSync("node", [CLI, "skill", "./plugin", "measure baseline variance", "--dry-run", "--ablate-skill", "--repeat", "3"], {
      encoding: "utf8",
      cwd: d,
    });
    expect(raw.stderr).not.toMatch(/cannot be combined/i);
    expect(raw.status).toBe(0);
  });
});
