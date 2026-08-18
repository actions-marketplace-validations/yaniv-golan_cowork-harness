import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// The two lanes where `question_options` is easy to get wrong, each pinned by the failure it would
// otherwise ship silently.
const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);

function gateFrame(question: string, optionLabels: string[]) {
  return {
    type: "control_request",
    request_id: "req-1",
    request: {
      subtype: "can_use_tool",
      tool_name: "AskUserQuestion",
      tool_use_id: "toolu_1",
      input: { questions: [{ question, options: optionLabels.map((label) => ({ label })) }] },
    },
  };
}

function keptRun(gate?: { question: string; options: string[] }, opts: { corruptEvents?: boolean; noEvents?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "cwh-qo-"));
  const workDir = join(root, "work", "session", "mnt");
  mkdirSync(join(workDir, "outputs"), { recursive: true });
  const t1 = join(root, "turns", "1");
  mkdirSync(t1, { recursive: true });
  writeFileSync(
    join(t1, "result.json"),
    JSON.stringify({
      scenario: "smoke",
      fidelity: "container",
      baseline: "desktop-1.14271.0",
      result: "success",
      // Deliberately EMPTY: the answer-time channel carries nothing here, proving this lane does not
      // read `decisions[].questions` (the design the reviews rejected).
      decisions: [],
      toolCounts: { Read: 1 },
      gateDeliveries: [],
      egress: [],
      assertions: [],
      subagents: [],
      outDir: root,
      workDir,
      durationMs: 1,
      scan: { outputsDeletes: [], hostPathLeaked: false, selfHealRan: false },
    }),
  );
  writeFileSync(join(t1, "run.jsonl"), JSON.stringify({ t: "run", scenario: "smoke" }) + "\n");
  // trace.json carries question TEXT only — the distilled sidecar drops options, which is why this lane
  // must read events.jsonl instead.
  writeFileSync(join(t1, "trace.json"), JSON.stringify({ questions: gate ? [gate.question] : [], steps: [] }));
  if (gate && !opts.noEvents) {
    const lines = opts.corruptEvents
      ? ["{ this is not json", JSON.stringify(gateFrame(gate.question, gate.options))]
      : [JSON.stringify(gateFrame(gate.question, gate.options))];
    writeFileSync(join(root, "events.jsonl"), lines.join("\n") + "\n");
  }
  return root;
}

function scenarioFile(dir: string, body: string): string {
  const f = join(dir, "scenario.yaml");
  writeFileSync(f, `name: smoke\nprompt: do the thing\nfidelity: container\n${body}`);
  return f;
}

function verifyRun(runDir: string, scenario: string) {
  const r = spawnSync("node", [CLI, "verify-run", runDir, scenario], { encoding: "utf8", cwd: mkdtempSync(join(tmpdir(), "cwh-qo-cwd-")) });
  return { code: r.status, text: (r.stderr || "") + (r.stdout || "") };
}

const Q = "The rubric doesn't fit this stage";
const OPTS = ["Stop review", "Proceed anyway"];

describe.skipIf(!can)("verify-run grades question_options from events.jsonl", () => {
  // THE regression this test exists for. `parseGatesFromEvents` is otherwise called only inside
  // `if (scenario.answers.length > 0)` — so a scenario that asserts option order with NO scripted
  // answers (on_unanswered: first, an LLM-decided gate, a post-hoc check on a kept run) would have
  // reached the evaluator with no evidence at all. That is the reporter's own gate-stop scenario style.
  it("grades with an EMPTY answers: block — the answer-coverage gate must not decide this", () => {
    const run = keptRun({ question: Q, options: OPTS });
    const sc = scenarioFile(
      run,
      `assert:\n  - question_options:\n      when_question: "rubric"\n      equals: ["Stop review", "Proceed anyway"]\n  - result: success\n`,
    );
    const r = verifyRun(run, sc);
    expect(r.code).toBe(0);
  });

  it("catches the reversed list on this lane too", () => {
    const run = keptRun({ question: Q, options: ["Proceed anyway", "Stop review"] });
    const sc = scenarioFile(
      run,
      `assert:\n  - question_options:\n      when_question: "rubric"\n      equals: ["Stop review", "Proceed anyway"]\n`,
    );
    const r = verifyRun(run, sc);
    expect(r.code).not.toBe(0);
    expect(r.text).toMatch(/question_options/);
  });

  // Absent or partly-corrupt evidence must fail closed. A present-but-corrupt events.jsonl is otherwise
  // indistinguishable from "those were all the gates", which would grade a partial set as complete.
  it("fails evidence-unavailable when events.jsonl is absent", () => {
    const run = keptRun({ question: Q, options: OPTS }, { noEvents: true });
    const sc = scenarioFile(
      run,
      `assert:\n  - question_options:\n      when_question: "rubric"\n      equals: ["Stop review", "Proceed anyway"]\n`,
    );
    const r = verifyRun(run, sc);
    expect(r.code).not.toBe(0);
    expect(r.text).toMatch(/evidence unavailable/);
  });

  it("fails evidence-unavailable when events.jsonl has an unparseable line", () => {
    const run = keptRun({ question: Q, options: OPTS }, { corruptEvents: true });
    const sc = scenarioFile(
      run,
      `assert:\n  - question_options:\n      when_question: "rubric"\n      equals: ["Stop review", "Proceed anyway"]\n`,
    );
    const r = verifyRun(run, sc);
    expect(r.code).not.toBe(0);
    expect(r.text).toMatch(/evidence unavailable/);
  });
});
