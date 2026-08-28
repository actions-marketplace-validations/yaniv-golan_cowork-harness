import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BINARY_TOOL_CANONICALIZATION, toolNameSpellings } from "../src/run/tool-name-canonicalization";
import { evaluate, type AssertContext } from "../src/assert";

// The BINARY's legacy→canonical tool-name rename, and the assertion matching that depends on it.
// Distinct from test/tool-aliases.test.ts, which covers the HARNESS-installed routing aliases
// (WORKSPACE_TOOL_ALIASES / VM_LOOP_TOOL_ALIASES) — different mechanism, no overlapping names.

function ctx(over: Partial<AssertContext> = {}): AssertContext {
  return {
    transcript: "",
    toolsCalled: new Set(),
    subagentTools: new Set(),
    egress: [],
    result: "success",
    workRoot: "/nonexistent",
    userVisiblePrefixes: ["outputs"],
    outputsDeletes: [],
    questions: [],
    hostPathLeaked: false,
    selfHealRan: false,
    subagents: [],
    gateDeliveries: [],
    toolResultTexts: [],
    skillsInvoked: [],
    skillToolAvailable: true,
    ...over,
  };
}

describe("toolNameSpellings", () => {
  it("expands a canonical name to include the legacy spellings that canonicalize into it", () => {
    expect(toolNameSpellings("Agent").sort()).toEqual(["Agent", "Task"]);
    // One-to-many: two legacy names share a canonical target.
    expect(toolNameSpellings("TaskStop").sort()).toEqual(["KillBash", "KillShell", "TaskStop"]);
  });

  it("leaves an unaliased name alone, and does not expand a LEGACY name (nothing canonicalizes into it)", () => {
    expect(toolNameSpellings("Read")).toEqual(["Read"]);
    // `Task` is never RECORDED — the binary emits `Agent` — so it has no reverse expansion of its own.
    expect(toolNameSpellings("Task")).toEqual(["Task"]);
  });

  it("shares no name with the harness's own routing aliases — the two maps are different mechanisms", () => {
    // WORKSPACE_TOOL_ALIASES maps Bash→mcp__workspace__bash as a tier ROUTING decision the harness makes.
    // If a name ever appeared in both, "which rename applies" would become ambiguous at match time.
    for (const n of ["Bash", "WebFetch"]) expect(Object.keys(BINARY_TOOL_CANONICALIZATION), n).not.toContain(n);
  });
});

describe("the tool keys accept either spelling", () => {
  // The live false green: `Task` was offered in 506 of 506 measured runs and called in 0 of them, while
  // `Agent` was called in 188 and offered in none. A literal matcher made the positive key impossible and
  // the negative key a permanent vacuous pass.
  const dispatched = ctx({ toolsCalled: new Set(["Agent", "Read"]) });

  it("tool_called: 'Task' matches a recorded Agent call", () => {
    expect(evaluate([{ tool_called: "Task" }], dispatched)[0]!.pass).toBe(true);
  });

  it("tool_not_called: 'Task' is VIOLATED by a recorded Agent call — the vacuous pass is gone", () => {
    expect(evaluate([{ tool_not_called: "Task" }], dispatched)[0]!.pass).toBe(false);
  });

  it("the canonical spelling keeps working unchanged", () => {
    expect(evaluate([{ tool_called: "Agent" }], dispatched)[0]!.pass).toBe(true);
    expect(evaluate([{ tool_not_called: "Agent" }], dispatched)[0]!.pass).toBe(false);
  });

  it("GLOBS see both spellings — the reason the recorded name is expanded, not the pattern", () => {
    // Rewriting the author's pattern would fix the literal `"Task"` and leave every glob shape broken.
    for (const g of ["Ta*", "Task*", "*", "T?sk"]) expect(evaluate([{ tool_not_called: g }], dispatched)[0]!.pass, g).toBe(false);
    expect(evaluate([{ tool_called: "Ta*" }], dispatched)[0]!.pass).toBe(true);
  });

  it("does not over-match: an unrelated pattern still misses, and a run with no dispatch still passes the negative", () => {
    expect(evaluate([{ tool_called: "Task" }], ctx({ toolsCalled: new Set(["Read"]) }))[0]!.pass).toBe(false);
    expect(evaluate([{ tool_not_called: "Task" }], ctx({ toolsCalled: new Set(["Read"]) }))[0]!.pass).toBe(true);
    expect(evaluate([{ tool_called: "Bash" }], dispatched)[0]!.pass).toBe(false);
  });

  it("the sub-agent tool keys inherit it — one matcher governs all four", () => {
    const sub = ctx({ subagentTools: new Set(["Agent"]) });
    expect(evaluate([{ subagent_tool_used: "Task" }], sub)[0]!.pass).toBe(true);
    expect(evaluate([{ subagent_tool_absent: "Task" }], sub)[0]!.pass).toBe(false);
  });
});

/** The staged VM agent binary, when this machine has a Claude Desktop install. Absent in CI. */
function stagedAgentBinary(): string | undefined {
  const root = join(homedir(), "Library", "Application Support", "Claude", "claude-code-vm");
  if (!existsSync(root)) return undefined;
  const versionFile = join(root, ".sdk-version");
  const version = existsSync(versionFile) ? readFileSync(versionFile, "utf8").trim() : undefined;
  const candidates = version ? [version] : readdirSync(root).filter((d) => !d.startsWith("."));
  for (const v of candidates) {
    const bin = join(root, v, "claude");
    if (existsSync(bin)) return bin;
  }
  return undefined;
}

const BINARY = stagedAgentBinary();

// Drift guard. BINARY_TOOL_CANONICALIZATION is a property of the AGENT BINARY, not of this repo, and
// nothing syncs it — so a binary that adds, drops or retargets an entry would silently desync the matcher
// from production. This diffs the table against the binary's own map. It cannot run in CI (no Desktop
// install), so it is a maintainer-machine guard: it fires during the very sync that would introduce the
// drift. Extracting the map in `cowork-sync` as a synced `spawn.toolAliases`, with the usual version
// sentinel, is the durable fix and remains follow-up work.
describe.skipIf(!BINARY)("BINARY_TOOL_CANONICALIZATION matches the staged agent binary", () => {
  it("every entry in the binary's canonicalizer map is present here, with the same target", () => {
    const blob = readFileSync(BINARY!, "latin1");
    // The map is emitted as a single object literal keyed on `Task:"Agent"`. Anchor on that pair rather
    // than on a variable name, which is minifier-assigned and changes between builds.
    const m = /Task:"Agent"[^}]*/.exec(blob);
    expect(m, 'the binary no longer contains a `Task:"Agent"` canonicalizer map — re-derive the table by hand').not.toBeNull();
    const fromBinary = Object.fromEntries([...m![0].matchAll(/(\w+):"(\w+)"/g)].map((p) => [p[1]!, p[2]!]));
    expect(Object.keys(fromBinary).length).toBeGreaterThanOrEqual(12);
    expect(fromBinary).toEqual({ ...BINARY_TOOL_CANONICALIZATION });
  });
});
