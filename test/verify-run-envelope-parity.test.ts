import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// `verify-run --output-format json` used to emit a FLAT payload — no `results[]`, no `verdict`, no
// `failures[]` — while `run` nested everything under `results[].verdict`. The consequence was not a
// missing field but a SILENT FALSE GREEN: the defensive jq idiom a user copies from `run`'s docs
// (`.results[]? | .verdict.failures[]? | select(.kind=="assertion")`) returns `[]` against a FAILED
// verify-run, because `.results` is null and the `?` swallows it. `[]` reads as "no failures".
//
// The fix is full envelope parity: verify-run emits `results[]` (always exactly one entry, the same way
// `run` on a single scenario does) whose entry carries a `verdict` of `run`'s shape. The flat keys stay
// for existing consumers. The cross-command query test below is what ENCODES that decision — if someone
// later "simplifies" the envelope back to a bare `verdict`, it fails.
const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);
const hasJq = spawnSync("jq", ["--version"], { encoding: "utf8" }).status === 0;

/** The documented `run` recipe for "did MY assertions fail?" — copied verbatim, spelled with the
 *  defensive `?` on `.results[]` that makes the failure silent rather than loud. */
const KIND_QUERY = '[.results[]? | .verdict.failures[]? | select(.kind=="assertion")]';

function turn1Dir(root: string): string {
  const d = join(root, "turns", "1");
  mkdirSync(d, { recursive: true });
  return d;
}

/** A kept run dir whose recorded run succeeded and used only `Read` — so `tool_called: Bash` is a
 *  failing authored assertion and `tool_called: Read` is a passing one. */
function keptRun(): string {
  const root = mkdtempSync(join(tmpdir(), "cwh-vrep-"));
  const workDir = join(root, "work", "session", "mnt");
  mkdirSync(join(workDir, "outputs"), { recursive: true });
  const result = {
    scenario: "smoke",
    fidelity: "container",
    baseline: "desktop-1.14271.0",
    result: "success",
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
  };
  const t1 = turn1Dir(root);
  writeFileSync(join(t1, "result.json"), JSON.stringify(result, null, 2));
  writeFileSync(join(t1, "run.jsonl"), JSON.stringify({ t: "run", scenario: "smoke" }) + "\n");
  writeFileSync(join(t1, "trace.json"), JSON.stringify({ questions: [], steps: [] }));
  return root;
}

function scenarioFile(dir: string, assertBody: string): string {
  const f = join(dir, "scenario.yaml");
  writeFileSync(f, `name: smoke\nprompt: do the thing\nfidelity: container\nassert:\n${assertBody}`);
  return f;
}

/** Run verify-run with the JSON envelope on stdout; returns the parsed envelope + raw stdout. */
function verifyRunJson(runDir: string, scenario: string): { code: number | null; env: Record<string, unknown>; raw: string } {
  const r = spawnSync("node", [CLI, "verify-run", runDir, scenario, "--output-format", "json"], {
    encoding: "utf8",
    cwd: mkdtempSync(join(tmpdir(), "cwh-vrepcwd-")),
  });
  const raw = (r.stdout || "").trim();
  return { code: r.status, env: JSON.parse(raw) as Record<string, unknown>, raw };
}

/** `jq -c <filter>` over a JSON document, parsed back. Only called when jq is present. */
function jq(filter: string, doc: string): unknown {
  const r = spawnSync("jq", ["-c", filter], { input: doc, encoding: "utf8" });
  expect(r.status, `jq failed: ${r.stderr}`).toBe(0);
  return JSON.parse(r.stdout);
}

function failingRun() {
  const run = keptRun();
  return { run, sc: scenarioFile(run, `  - tool_called: Bash\n`) };
}

describe.skipIf(!can)("verify-run --output-format json: envelope parity with run", () => {
  it("a failed assertion appears as results[0].verdict.failures[] with kind: assertion", () => {
    const { run, sc } = failingRun();
    const { code, env } = verifyRunJson(run, sc);
    expect(code).toBe(1);
    expect(env.ok).toBe(false);
    const results = env.results as Array<{ verdict: { pass: boolean; failures: Array<{ assertion?: string; kind: string }> } }>;
    expect(Array.isArray(results)).toBe(true);
    expect(results).toHaveLength(1); // always exactly one — verify-run judges one run dir
    expect(results[0].verdict.pass).toBe(false);
    expect(results[0].verdict.failures).toContainEqual(expect.objectContaining({ assertion: "tool_called", kind: "assertion" }));
  });

  it("a passing run reports ok + an empty failures[]", () => {
    const run = keptRun();
    const sc = scenarioFile(run, `  - tool_called: Read\n`);
    const { code, env } = verifyRunJson(run, sc);
    expect(code).toBe(0);
    expect(env.ok).toBe(true);
    const results = env.results as Array<{ verdict: { pass: boolean; failures: unknown[] } }>;
    expect(results[0].verdict.pass).toBe(true);
    expect(results[0].verdict.failures).toEqual([]);
  });

  // THE regression test for the reported defect. A field-presence check would not have caught the
  // original bug and would not protect the fix; this runs the actual documented query.
  it.skipIf(!hasJq)("the `run` kind query returns the failure against a FAILED verify-run (was a silent [])", () => {
    const { run, sc } = failingRun();
    const { raw } = verifyRunJson(run, sc);
    const hits = jq(KIND_QUERY, raw) as unknown[];
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]).toMatchObject({ kind: "assertion", assertion: "tool_called" });
  });

  it.skipIf(!hasJq)("the same query returns [] against a PASSING verify-run — the empty answer must stay meaningful", () => {
    const run = keptRun();
    const sc = scenarioFile(run, `  - tool_called: Read\n`);
    const { raw } = verifyRunJson(run, sc);
    expect(jq(KIND_QUERY, raw)).toEqual([]);
  });

  // Parity is ADDITIVE. Existing consumers key off the flat fields; the envelope comment in cli.ts
  // records that every prior field is preserved deliberately.
  it("keeps the flat pass / assertions[] / signals[] keys", () => {
    const { run, sc } = failingRun();
    const { env } = verifyRunJson(run, sc);
    expect(env.pass).toBe(false);
    const assertions = env.assertions as Array<{ assertion: unknown; pass: boolean; message?: string }>;
    expect(assertions).toHaveLength(1);
    expect(assertions[0]).toMatchObject({ assertion: { tool_called: "Bash" }, pass: false });
    expect(Array.isArray(env.signals)).toBe(true);
    expect(env.tool).toBe("cowork-harness");
    expect(env.command).toBe("verify-run");
    expect(env.error).toBe(null);
  });
});
