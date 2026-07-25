import { describe, it, expect } from "vitest";
import { replayCassette, buildEnvironmentProvenance, computeStaleness } from "../src/run/cassette.js";
import { readFileSync } from "node:fs";

/** A minimal cassette structure for testing. */
function makeMinimalCassette(overrides: Record<string, any> = {}): any {
  return {
    scenario: {
      name: "test",
      baseline: "latest",
      session: "(inline)",
      fidelity: "container",
      prompt: "hi",
      answers: [],
      expect_denied: [],
      assert: [{ result: "success" }],
    },
    events: [
      JSON.stringify({ type: "system", subtype: "init", tools: ["Bash"] }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false }),
    ],
    controlOut: [],
    ...overrides,
  };
}

describe("Cassette.environment field", () => {
  it("a cassette WITH environment field carries location, tier, and optionally agentBinaryFormat", async () => {
    const cassette = makeMinimalCassette({
      environment: {
        location: "local",
        tier: "hostloop",
        agentBinaryFormat: "elf",
      },
    });
    expect(cassette.environment).toEqual({
      location: "local",
      tier: "hostloop",
      agentBinaryFormat: "elf",
    });
  });

  it("an OLDER cassette WITHOUT environment field still replays successfully (backward-compat)", async () => {
    // Omit the environment field entirely — it's optional.
    const cassette = makeMinimalCassette();
    delete cassette.environment;

    // Replay should succeed without error, ignoring the missing field.
    const result = await replayCassette(cassette);
    expect(result.result).toBe("success");
    // The cassette lacks environment, so it should replay cleanly.
    expect(result).toBeDefined();
  });

  it("environment.agentBinaryFormat is optional — can be omitted", async () => {
    const cassette = makeMinimalCassette({
      environment: {
        location: "local",
        tier: "container",
        // agentBinaryFormat deliberately omitted
      },
    });
    expect(cassette.environment.location).toBe("local");
    expect(cassette.environment.tier).toBe("container");
    expect(cassette.environment.agentBinaryFormat).toBeUndefined();
  });

  it("environment.tier is optional — can be omitted", async () => {
    const cassette = makeMinimalCassette({
      environment: {
        location: "local",
        // tier deliberately omitted
      },
    });
    expect(cassette.environment.location).toBe("local");
    expect(cassette.environment.tier).toBeUndefined();
  });
});

describe("RunResult.execution — replay-site wiring (reads Cassette.environment)", () => {
  it("a replay of a cassette WITH environment stamped reproduces that location", async () => {
    const cassette = makeMinimalCassette({
      environment: { location: "local", tier: "hostloop", agentBinaryFormat: "elf" },
    });
    const result = await replayCassette(cassette);
    expect(result.execution).toEqual({ location: "local" });
  });

  it("a replay of a cassette WITHOUT environment (older/pre-taxonomy) yields execution: undefined — not a false 'local' claim", async () => {
    const cassette = makeMinimalCassette();
    delete cassette.environment;
    const result = await replayCassette(cassette);
    expect(result.execution).toBeUndefined();
  });
});

// --- harnessVersion provenance + the discovery-surface note (1.11.0) ------------------------------
describe("buildEnvironmentProvenance — recording provenance (pure, offline-testable)", () => {
  // Read package.json DIRECTLY rather than comparing against pkgVersion(): asserting
  // toBe(pkgVersion()) is circular — it survives the mutation "return a wrong constant sourced from
  // that same call". The point of extracting the helper was an assertion that can actually fail.
  const declared = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;

  it("stamps the recording CLI's version", () => {
    expect(buildEnvironmentProvenance("container", "elf").harnessVersion).toBe(declared);
  });
  it("always marks the recording local, and passes tier/format through", () => {
    expect(buildEnvironmentProvenance("hostloop", "macho")).toEqual({
      location: "local",
      tier: "hostloop",
      agentBinaryFormat: "macho",
      harnessVersion: declared,
    });
  });
  it("tolerates an absent tier / binary format", () => {
    const e = buildEnvironmentProvenance(undefined, undefined);
    expect(e.location).toBe("local");
    expect(e.harnessVersion).toBe(declared);
  });
});

describe("discovery-surface note — answers 'does this cassette predate the discovery tools?'", () => {
  const notesFor = (o: Record<string, any>) => computeStaleness(makeMinimalCassette(o) as any, undefined).notes.join(" | ");
  const init = (tools?: unknown) =>
    JSON.stringify(tools === undefined ? { type: "system", subtype: "init" } : { type: "system", subtype: "init", tools });
  const result = JSON.stringify({ type: "result", subtype: "success", is_error: false });

  it("FIRES on a container cassette whose recorded inventory lacks the discovery tools", () => {
    const n = notesFor({ events: [init(["Bash", "Read"]), result], effectiveFidelity: "container" });
    expect(n).toContain("discovery-surface");
    expect(n).toContain("container");
  });
  it("FIRES on hostloop too", () => {
    expect(notesFor({ events: [init(["Bash"]), result], effectiveFidelity: "hostloop" })).toContain("discovery-surface");
  });
  it("is SILENT once the inventory carries the discovery tools", () => {
    const n = notesFor({ events: [init(["Bash", "mcp__skills__list_skills"]), result], effectiveFidelity: "container" });
    expect(n).not.toContain("discovery-surface");
  });

  // The guard that keeps a synthetic fixture from being told to re-record. An init event with NO
  // `tools` key (test/evals/files/report-check.cassette.json is exactly this shape) is NO EVIDENCE —
  // not "the tools are missing".
  it("is SILENT when the init event carries no tools key at all", () => {
    expect(notesFor({ events: [init(undefined), result], effectiveFidelity: "hostloop" })).not.toContain("discovery-surface");
  });
  it("is SILENT on an empty tools array (same no-evidence rule)", () => {
    expect(notesFor({ events: [init([]), result], effectiveFidelity: "container" })).not.toContain("discovery-surface");
  });

  // Re-recording at these tiers would NEVER produce the tools, so the advice would be a dead end.
  it("is SILENT at microvm and protocol", () => {
    for (const tier of ["microvm", "protocol"]) {
      expect(notesFor({ events: [init(["Bash"]), result], effectiveFidelity: tier })).not.toContain("discovery-surface");
    }
  });
  it("is SILENT when no tier resolves (never guess a tier into an advisory)", () => {
    const n = notesFor({
      events: [init(["Bash"]), result],
      effectiveFidelity: undefined,
      scenario: { ...makeMinimalCassette().scenario, fidelity: "cowork" },
    });
    expect(n).not.toContain("discovery-surface");
  });

  // The oldest cassettes predate BOTH environment.tier and effectiveFidelity — the population the
  // note most wants to reach. scenario.fidelity is the third source for exactly that reason.
  it("falls back to a non-cowork scenario.fidelity when the newer tier fields are absent", () => {
    const n = notesFor({
      events: [init(["Bash"]), result],
      effectiveFidelity: undefined,
      scenario: { ...makeMinimalCassette().scenario, fidelity: "container" },
    });
    expect(n).toContain("discovery-surface");
  });
  it("prefers environment.tier over effectiveFidelity", () => {
    const n = notesFor({
      events: [init(["Bash"]), result],
      effectiveFidelity: "protocol",
      environment: { location: "local", tier: "container" },
    });
    expect(n).toContain("container");
  });

  // `events` is typed as required but several callers reach computeStaleness with it absent
  // (checkStaleness in the staleness/agent-scope suites). The first cut of this crashed the whole
  // staleness path with "cassette.events is not iterable" — 7 suite failures.
  it("does not throw when the cassette carries no events array at all", () => {
    const c = makeMinimalCassette({ effectiveFidelity: "container" }) as any;
    delete c.events;
    expect(() => computeStaleness(c, undefined)).not.toThrow();
    expect(computeStaleness(c, undefined).notes.join(" ")).not.toContain("discovery-surface");
  });

  it("is a NOTE, never a gating finding (a finding would red every consumer's fleet on upgrade)", () => {
    const r = computeStaleness(makeMinimalCassette({ events: [init(["Bash"]), result], effectiveFidelity: "container" }) as any, undefined);
    expect(r.notes.join(" ")).toContain("discovery-surface");
    expect(r.findings.map((f) => f.class)).not.toContain("discovery-surface");
    expect(r.findings.some((f) => JSON.stringify(f).includes("discovery-surface"))).toBe(false);
  });
});
