/** Legacy tool names the AGENT BINARY canonicalizes, and why the harness has to know about them.
 *
 * NOT to be confused with `WORKSPACE_TOOL_ALIASES` / `VM_LOOP_TOOL_ALIASES` (src/runtime/hostloop.ts).
 * Those are aliases the HARNESS installs to route a model's `Bash` to `mcp__workspace__bash` at a tier
 * that replaces the built-in — a routing decision, tier-specific, ours. This map is the BINARY's own
 * legacy→canonical rename of tool NAMES, tier-independent, and not ours to change. The two never
 * overlap: no name appears in both.
 *
 * THE DEFECT THIS EXISTS FOR. `spawn.tools` (from the synced baseline, ultimately from Desktop's asar)
 * declares the sub-agent dispatch tool as **`Task`**. The binary accepts that spelling, echoes it back
 * UN-canonicalized in the `system:init` tool inventory, and then emits every actual call as **`Agent`**.
 * Measured across 506 kept runs: `Task` offered 506 times and called **0**; `Agent` offered **0** times
 * and called 188. So `tool_called: "Task"` could never pass and `tool_not_called: "Task"` always passed —
 * a false green at every tier, in the most common dispatch assertion there is.
 *
 * WHERE THE RENAME LIVES. Not here. `src/agent/session.ts` records `name: block.name` verbatim off the
 * SDK stream and `src/run/run.ts` keys `toolCounts` on it — the harness renames nothing, and
 * `trace-view.ts`'s `name: "Agent"` is a display label on a viewer row that never reaches `toolCounts`.
 * The map below is lifted from the shipping agent binary (`claude-code-vm/2.1.246/claude`), where it is
 * applied as `i(e) { return Object.hasOwn(c, e) ? c[e] : e }` — a legacy→canonical canonicalizer over
 * exactly these twelve entries. It therefore models PRODUCTION, not a harness artifact.
 *
 * DATA IS STORED VERBATIM; ONLY MATCHING IS ALIAS-AWARE. Nothing here rewrites a recorded name.
 * `toolCounts`, `context.tools` and every cassette keep exactly what the agent reported — the same
 * posture `RunResult.models` documents for model ids, and the reason a `result.json` stays a faithful
 * record rather than a normalized one. The aliasing is applied at ASSERTION-MATCH time so an author may
 * write either spelling; `tool_available: "Task"` keeps matching the inventory's literal `Task`, and no
 * committed cassette changes meaning.
 *
 * VERSION-COUPLED. This is a property of the agent binary and can change when it does. It is NOT yet
 * extracted by `cowork-sync` into the baseline — `test/tool-name-canonicalization.test.ts` diffs it against the staged
 * binary when one is present (skipped in CI, which has no Desktop install), so drift is caught on a
 * maintainer's machine during the sync that would introduce it. Folding it into `sync` as a synced
 * `spawn.toolAliases`, with the usual version sentinel, is the durable fix and remains follow-up work.
 *
 * DO NOT ADD AN ENTRY FROM A GREP OF RUN DATA. "Called but not offered" is equally the signature of a
 * MODEL HALLUCINATING A TOOL NAME: the one observed `mcp__workspace__present_files` call sits in its
 * run's `toolErrors` with `presentedFiles: []`. Only names verified in the binary's own map belong here.
 */
export const BINARY_TOOL_CANONICALIZATION: Readonly<Record<string, string>> = Object.freeze({
  Task: "Agent",
  KillShell: "TaskStop",
  KillBash: "TaskStop",
  AgentOutputTool: "TaskOutput",
  BashOutputTool: "TaskOutput",
  AgentOutput: "TaskOutput",
  BashOutput: "TaskOutput",
  ListPeers: "ListAgents",
  Brief: "SendUserMessage",
  ListMcpResources: "ListMcpResourcesTool",
  ReadMcpResource: "ReadMcpResourceTool",
  ReadMcpResourceDir: "ReadMcpResourceDirTool",
});

/** canonical → the legacy spellings that canonicalize to it. Several legacy names share one canonical
 *  target (`KillShell`/`KillBash` → `TaskStop`), so this is one-to-many. */
const LEGACY_BY_CANONICAL: Readonly<Record<string, string[]>> = Object.freeze(
  Object.entries(BINARY_TOOL_CANONICALIZATION).reduce<Record<string, string[]>>((acc, [legacy, canonical]) => {
    (acc[canonical] ??= []).push(legacy);
    return acc;
  }, {}),
);

/** Every spelling an author could reasonably use for a RECORDED tool name: the name itself, plus the
 *  legacy names the binary would have canonicalized into it.
 *
 *  Expanding the recorded NAME rather than the author's PATTERN is load-bearing: these keys are
 *  GLOB-matched, so rewriting the pattern would fix `tool_not_called: "Task"` and leave
 *  `tool_not_called: "Ta*"` and `"*"` just as broken. Expanding the name means every pattern shape —
 *  literal, prefix glob, bare `*` — sees both spellings. */
export function toolNameSpellings(recordedName: string): string[] {
  const legacy = LEGACY_BY_CANONICAL[recordedName];
  return legacy ? [recordedName, ...legacy] : [recordedName];
}
