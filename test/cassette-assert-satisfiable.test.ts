import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { anyGlobMatches } from "../src/glob";

// A committed cassette's `tool_not_called` must be VIOLABLE by that cassette's own recorded run.
//
// The trap this exists for, found while designing the tool-name vacuity work and confirmed by
// measurement over 506 real kept runs: the tool surface at a tier is GATE-CONDITIONAL. At `container`,
// `mcp__workspace__web_fetch` is offered only when `coworkWebFetchViaApi` is on — 17 of 138 measured
// container runs. With the gate off, `WebFetch` is offered instead and `mcp__workspace__web_fetch` is
// absent from the inventory entirely.
//
// `examples/replays/example-pdf-skill.cassette.json` asserts `tool_not_called:
// "mcp__workspace__web_fetch"` at container and passes today only because it was recorded gate-ON. A
// re-record with the gate off would leave that assertion naming a tool the run could never have called:
// it would keep passing, forever, having stopped verifying anything. Nothing in the suite would notice —
// `verify-cassettes`'s `replaced-builtin` note keys on the recorded INVENTORY, never on the assertions,
// and only for built-ins being replaced, never the inverse.
//
// SCOPE — deliberately narrow, and the exclusions matter:
//   * `subagent_tool_absent` is judged against `subagents[].declaredTools`, a DIFFERENT per-dispatch
//     inventory. Checking it against the main-agent init list would be a category error, so it is not
//     checked here. It has the same exposure and wants its own guard.
//   * This canNOT see the alias class of vacuity: `tool_not_called: "Task"` would pass this guard (`Task`
//     IS in every init inventory) while being permanently vacuous, because the agent binary canonicalizes
//     `Task` to `Agent` and only ever EMITS `Agent`. That is a separate fix (canonicalize at ingest);
//     this guard is about offeredness alone. Do not read a green here as "the assertion is meaningful".

// `readdirSync`, not `fs.globSync`: the repo deliberately avoids that dependency (see the hand-rolled
// expander in src/run/analyze-skill.ts, "no `engines.node` bump (owner decision)"), and two shallow
// listings do not justify breaking the convention.
const CASSETTE_DIRS = ["cassettes", "examples/replays"];
const CASSETTES = CASSETTE_DIRS.flatMap((d) =>
  readdirSync(resolve(d))
    .filter((f) => f.endsWith(".json"))
    .map((f) => join(d, f)),
).sort();

interface Cassette {
  scenario?: { fidelity?: string; assert?: Record<string, unknown>[] };
  events?: string[];
}

/** The tool inventory the recorded run's agent was offered, or undefined when the cassette froze none. */
function recordedInitTools(c: Cassette): string[] | undefined {
  if (!Array.isArray(c.events)) return undefined;
  for (const line of c.events) {
    let m: { type?: string; subtype?: string; tools?: unknown };
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m?.type !== "system" || m?.subtype !== "init") continue;
    return Array.isArray(m.tools) ? (m.tools as unknown[]).filter((t): t is string => typeof t === "string") : undefined;
  }
  return undefined;
}

function toolAsserts(c: Cassette, key: "tool_called" | "tool_not_called"): string[] {
  return (c.scenario?.assert ?? []).flatMap((a) => (typeof a[key] === "string" ? [a[key] as string] : []));
}

const loaded = CASSETTES.map((f) => ({ file: f, cassette: JSON.parse(readFileSync(resolve(f), "utf8")) as Cassette }));

describe("a committed cassette's tool assertions are satisfiable against its own recorded inventory", () => {
  it("finds cassettes carrying tool assertions (a guard that scans nothing passes vacuously — the same bug it checks for)", () => {
    expect(loaded.length).toBeGreaterThan(0);
    const withAsserts = loaded.filter(
      (l) => toolAsserts(l.cassette, "tool_called").length || toolAsserts(l.cassette, "tool_not_called").length,
    );
    expect(withAsserts.length, `no committed cassette asserts tool_called/tool_not_called — did the fixtures move?`).toBeGreaterThan(0);
  });

  for (const { file, cassette } of loaded) {
    const notCalled = toolAsserts(cassette, "tool_not_called");
    const called = toolAsserts(cassette, "tool_called");
    if (!notCalled.length && !called.length) continue;

    it(`${file}: every tool_not_called names a tool the recorded run was OFFERED`, () => {
      const init = recordedInitTools(cassette);
      // No frozen inventory is "no evidence", not "the tools are missing" — same posture as
      // computeReplacedBuiltinNote. Skip rather than invent a verdict.
      if (init === undefined) return;
      for (const pattern of notCalled) {
        // Same glob engine the evaluator uses (`toolMatches` in src/assert.ts), so this guard and the
        // assertion can never disagree about what a pattern matches.
        const offered = init.filter((t) => anyGlobMatches([pattern], t));
        expect(
          offered.length,
          `${file}: \`tool_not_called: "${pattern}"\` matches NO tool in this cassette's recorded init ` +
            `inventory (${init.length} tools), so the recorded run could never have violated it — it passes ` +
            `vacuously and verifies nothing. Most likely this cassette was re-recorded under a different ` +
            `gate or tier and the tool is now served under another name. Fix the assertion to name the tool ` +
            `this recording actually offers, or drop it.`,
        ).toBeGreaterThan(0);
      }
    });

    it(`${file}: every tool_called names a tool the recorded run was OFFERED`, () => {
      const init = recordedInitTools(cassette);
      if (init === undefined) return;
      for (const pattern of called) {
        const offered = init.filter((t) => anyGlobMatches([pattern], t));
        // A `tool_called` naming an unoffered tool fails on replay anyway, so this is not a false green —
        // it is a clearer diagnosis than "no tool matched", which sends the reader to look at the agent's
        // behaviour when the tool was never on the menu.
        expect(
          offered.length,
          `${file}: \`tool_called: "${pattern}"\` matches NO tool in this cassette's recorded init inventory ` +
            `(${init.length} tools) — the tool was never offered to the recorded run, so this can never pass.`,
        ).toBeGreaterThan(0);
      }
    });
  }
});

describe("the guard itself fires on the shape it exists to catch", () => {
  // Without this, the suite above is green whether or not the check works — every committed cassette
  // currently passes it, so nothing would distinguish a working guard from a no-op one.
  const gateOffContainerInventory = ["Bash", "Read", "Write", "WebFetch", "Task", "AskUserQuestion"];

  it("a gate-OFF container inventory makes the shipped example's assertion vacuous", () => {
    const pattern = "mcp__workspace__web_fetch";
    expect(gateOffContainerInventory.filter((t) => anyGlobMatches([pattern], t))).toEqual([]);
  });

  it("the same assertion IS satisfiable against the gate-ON inventory the fixture actually froze", () => {
    const pdf = loaded.find((l) => l.file.includes("example-pdf-skill"));
    expect(pdf, "example-pdf-skill cassette not found — update this guard's anchor").toBeDefined();
    const init = recordedInitTools(pdf!.cassette)!;
    expect(init).toContain("mcp__workspace__web_fetch");
  });
});
