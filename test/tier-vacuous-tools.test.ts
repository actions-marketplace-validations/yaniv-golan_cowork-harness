import { describe, it, expect } from "vitest";
import { tierVacuousTool, tierVacuousMessage } from "../src/run/tier-vacuous-tools";

// `tool_not_called` on a tool the TIER never serves passes vacuously — it can never be violated. This
// table is what the harness refuses at load. The tests that matter most are the NEGATIVE ones: the check
// is a hard refusal, so a false positive makes a legitimate scenario unrunnable.

const GATE_ON = true;
const GATE_OFF = false;

describe("tools a tier provably does not serve", () => {
  it("hostloop replaces Bash and WebFetch, and removes NotebookEdit", () => {
    expect(tierVacuousTool("Bash", "hostloop", GATE_ON)).toEqual({ tool: "Bash", tier: "hostloop", instead: "mcp__workspace__bash" });
    expect(tierVacuousTool("WebFetch", "hostloop", GATE_ON)).toEqual({
      tool: "WebFetch",
      tier: "hostloop",
      instead: "mcp__workspace__web_fetch",
    });
    // Removed outright, so there is nothing to assert instead.
    expect(tierVacuousTool("NotebookEdit", "hostloop", GATE_ON)).toEqual({ tool: "NotebookEdit", tier: "hostloop", instead: null });
  });

  it("container keeps the built-in shell — the INVERSE direction is what is vacuous there", () => {
    expect(tierVacuousTool("Bash", "container", GATE_ON)).toBeUndefined();
    expect(tierVacuousTool("mcp__workspace__bash", "container", GATE_ON)).toEqual({
      tool: "mcp__workspace__bash",
      tier: "container",
      instead: "Bash",
    });
  });

  it("WebFetch at container is vacuous only when the VM-loop swap gate is ON", () => {
    expect(tierVacuousTool("WebFetch", "container", GATE_ON)?.instead).toBe("mcp__workspace__web_fetch");
    expect(tierVacuousTool("WebFetch", "container", GATE_OFF)).toBeUndefined();
  });

  it("microvm serves no workspace tools at all", () => {
    expect(tierVacuousTool("mcp__workspace__bash", "microvm", GATE_ON)?.instead).toBe("Bash");
    expect(tierVacuousTool("mcp__workspace__web_fetch", "microvm", GATE_ON)?.instead).toBe("WebFetch");
    expect(tierVacuousTool("Bash", "microvm", GATE_ON)).toBeUndefined();
  });

  it("protocol is never judged — its surface is the operator's own host CLI registry", () => {
    for (const t of ["Bash", "WebFetch", "NotebookEdit", "mcp__workspace__bash"])
      expect(tierVacuousTool(t, "protocol", GATE_ON), t).toBeUndefined();
  });
});

describe("what the check must NOT reject — it is a hard refusal, so a false positive is unrunnable", () => {
  it("an MCP tool from a session mcp.config is never rejected", () => {
    // The finding that sank the general design: `--tools` gates the BUILT-IN set only ("Specify the list
    // of available tools from the built-in set" — the binary's own help), while every tier separately
    // passes --mcp-config. A launch-set-derived check would have rejected this while the tool was
    // registered and callable — and a destructive third-party tool is the most valuable thing there is
    // to assert `tool_not_called` on. The repo ships examples/data/mcp.json declaring exactly such a
    // server.
    for (const tier of ["hostloop", "container", "microvm"])
      expect(tierVacuousTool("mcp__example-fs__write_file", tier, GATE_ON), tier).toBeUndefined();
  });

  it("a tool that is merely UNUSED is never rejected — only ones the tier does not serve", () => {
    // WebFetch at container with the gate off is offered and simply went uncalled in every measured run.
    // That is a real, satisfiable assertion.
    expect(tierVacuousTool("WebFetch", "container", GATE_OFF)).toBeUndefined();
    expect(tierVacuousTool("Read", "hostloop", GATE_ON)).toBeUndefined();
  });

  it("GLOBS are never rejected — a pattern is not a literal claim about one tool", () => {
    for (const g of ["mcp__*", "*", "Ba*", "B?sh", "mcp__workspace__*"]) expect(tierVacuousTool(g, "hostloop", GATE_ON), g).toBeUndefined();
  });

  it("an out-of-table name is not rejected, even when it happens to be vacuous", () => {
    // `REPL` is in spawn.tools but absent from the binary's registry, so it is genuinely unservable —
    // and deliberately NOT caught. The table is closed on purpose: under-approximating is the correct
    // side to err on when the verdict is a refusal.
    expect(tierVacuousTool("REPL", "hostloop", GATE_ON)).toBeUndefined();
    expect(tierVacuousTool("JavaScript", "hostloop", GATE_ON)).toBeUndefined();
  });

  it("an unknown tier is inert rather than guessing", () => {
    expect(tierVacuousTool("Bash", "some-future-tier", GATE_ON)).toBeUndefined();
  });
});

describe("the refusal message", () => {
  it("names the replacement, and the sibling keys it does not cover", () => {
    const m = tierVacuousMessage(tierVacuousTool("Bash", "hostloop", GATE_ON)!, "my-scenario");
    expect(m).toMatch(/my-scenario/);
    expect(m).toMatch(/can never be violated at fidelity `hostloop`/);
    expect(m).toMatch(/passes vacuously and verifies nothing/);
    expect(m).toMatch(/tool_not_called: "mcp__workspace__bash"/); // the remedy, spelled out
    expect(m).toMatch(/tool_called: "Bash"` fails normally/); // the sibling that behaves differently
    expect(m).toMatch(/subagent_tool_absent/);
  });

  it("says there is nothing to assert instead when the tier simply removes the tool", () => {
    const m = tierVacuousMessage(tierVacuousTool("NotebookEdit", "hostloop", GATE_ON)!, "s");
    expect(m).toMatch(/removes `NotebookEdit` outright.*no replacement.*drop this assertion/s);
  });
});

// ── the wiring: a real scenario load must actually refuse ────────────────────────────────────────────
// The table above is inert unless executeScenario consults it. These drive the real load path, which
// throws before buildLaunchPlan and before any spawn — token-free, no Docker (the same property
// test/execute-origin-guard.test.ts relies on).
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeScenario, parseScenarioFile } from "../src/run/execute";

function scenarioWith(tier: string, asserts: string): ReturnType<typeof parseScenarioFile> {
  const dir = mkdtempSync(join(tmpdir(), "cwh-tv-"));
  writeFileSync(join(dir, "s.yaml"), "folders: []\n");
  const f = join(dir, "sc.yaml");
  writeFileSync(f, `name: tv\nbaseline: latest\nsession: (inline)\nfidelity: ${tier}\nprompt: hi\nassert:\n${asserts}`);
  return parseScenarioFile(f);
}

describe("executeScenario refuses a tier-vacuous tool_not_called at load", () => {
  it("rejects `Bash` at hostloop, naming the replacement", async () => {
    await expect(executeScenario(scenarioWith("hostloop", `  - tool_not_called: Bash\n`))).rejects.toThrow(
      /can never be violated at fidelity `hostloop`[\s\S]*mcp__workspace__bash/,
    );
  });

  it("rejects the INVERSE at container", async () => {
    await expect(executeScenario(scenarioWith("container", `  - tool_not_called: mcp__workspace__bash\n`))).rejects.toThrow(
      /can never be violated at fidelity `container`/,
    );
  });

  // NO negative cases here, deliberately. Passing the check means the load CONTINUES into staging and a
  // real container spawn — Docker, minutes, and a flaky unit test. The "must not reject" cases live in
  // the table describe above instead, which is where the decision is actually made: executeScenario
  // passes the pattern straight through, so a name absent from the table cannot be refused here.
});
