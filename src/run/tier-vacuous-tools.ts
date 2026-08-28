import { WORKSPACE_TOOL_ALIASES, VM_LOOP_TOOL_ALIASES } from "../runtime/hostloop.js";

/** Tools a tier PROVABLY does not serve, and what to write instead.
 *
 * THE DEFECT. `tool_not_called: "Bash"` at `hostloop` passes vacuously, always: that tier replaces the
 * built-in shell with `mcp__workspace__bash`, so the run could never have called `Bash` whatever the
 * agent did. The assertion reads as a guarantee and verifies nothing. The inverse is equally broken —
 * `tool_not_called: "mcp__workspace__bash"` at `container`, where the built-in `Bash` is served instead.
 *
 * WHY THIS TABLE IS CLOSED, AND NOT DERIVED FROM THE LAUNCH PLAN. The obvious implementation computes
 * the offered set as `spawn.tools − disallowed + extraTools` (what `argv.ts` passes as `--tools`) and
 * rejects any pattern matching nothing in it. That is UNSOUND: the agent binary's own help text reads
 * "--tools … Specify the list of available tools **from the built-in set**", and every sandbox tier
 * separately passes `--mcp-config`. A session's `mcp.config` server — a documented feature the repo ships
 * an example of (`examples/data/mcp.json`) — registers tools that appear in no launch set, so
 * `tool_not_called: "mcp__example-fs__write_file"` would have been rejected while the tool was registered
 * and callable. That is the single most valuable kind of negative assertion there is.
 *
 * So this table names ONLY tools the harness itself removes or registers, per tier. It never consults
 * `spawn.tools`, which makes it immune to that hole by construction, independent of the baseline (a
 * `spawn`-less baseline cannot make it misfire), and unable to collide with any MCP name. The cost is
 * that it under-approximates — `REPL` at hostloop is genuinely vacuous too and is not caught — which is
 * the correct side to err on when the verdict is a hard refusal.
 *
 * A fired reject therefore CANNOT be a false positive, which is why there is no opt-out. The repo's eight
 * `allow_*` modifiers all cover cases where the harness might be wrong about a real signal; here there is
 * no legitimate scenario to rescue. If one is ever found, the table is wrong and the table should change.
 */
const TIER_VACUOUS: Record<string, Record<string, string | null>> = {
  // The host loop disallows Bash and WebFetch and aliases both (WORKSPACE_TOOL_ALIASES), and disallows
  // NotebookEdit outright with no replacement.
  hostloop: { ...WORKSPACE_TOOL_ALIASES, NotebookEdit: null },
  // The VM loop keeps the built-in shell, so `Bash` is legitimate here — only the workspace shell is not
  // served, because this tier registers no workspace bash server.
  container: { mcp__workspace__bash: "Bash" },
  // microvm passes neither `disallowed` nor `extraTools` (runtime/microvm.ts), so it registers no
  // workspace server at all and keeps every built-in. Derived from that, not measured: the run population
  // this table was built against contains zero microvm runs.
  microvm: { mcp__workspace__bash: "Bash", mcp__workspace__web_fetch: "WebFetch" },
  // `protocol` is deliberately ABSENT. It passes no --tools/--allowedTools/--disallowedTools at all
  // (runtime/protocol.ts), so its surface is the operator's own host CLI registry — machine-dependent,
  // varying with their CLI version, and about a different product. Any verdict there would be noise.
};

/** The VM loop aliases WebFetch only when `coworkWebFetchViaApi` is on, so `WebFetch` at `container` is
 *  vacuous only in that configuration — passed in rather than read here, so this module stays pure. */
function containerVacuous(webFetchViaApi: boolean): Record<string, string | null> {
  return webFetchViaApi ? { ...TIER_VACUOUS.container, ...VM_LOOP_TOOL_ALIASES } : { ...TIER_VACUOUS.container };
}

export interface TierVacuousFinding {
  tool: string;
  tier: string;
  /** The tool to assert instead, or null when the tier removes it with no replacement. */
  instead: string | null;
}

/** Is this EXACT tool name provably unservable at this tier? Literals only — a glob is never rejected,
 *  since `mcp__*` or `Ba*` can match something the tier does serve. */
export function tierVacuousTool(pattern: string, tier: string, webFetchViaApi: boolean): TierVacuousFinding | undefined {
  // A pattern with a glob metacharacter is not a literal claim about one tool.
  if (/[*?]/.test(pattern)) return undefined;
  const table = tier === "container" ? containerVacuous(webFetchViaApi) : TIER_VACUOUS[tier];
  if (!table || !(pattern in table)) return undefined;
  return { tool: pattern, tier, instead: table[pattern] ?? null };
}

/** Keys this refusal covers. Both are NEGATIVE tool assertions judged against a set of names the tier
 *  never produces, so both pass vacuously in exactly the same way.
 *
 *  `subagent_tool_absent` belongs here despite an earlier belief that it did not. It reads
 *  `ctx.subagentTools` — the tools sub-agents actually USED (`assert.ts:1418`) — NOT
 *  `subagents[].declaredTools`, so there is no second inventory and no category error. Corroborated by
 *  the run population: sub-agent `Bash` calls appear 20 times, all at `container`, never at `hostloop`.
 *  Excluding it left the harness refusing `tool_not_called: "Bash"` at hostloop while silently greening
 *  `subagent_tool_absent: "Bash"` — teaching an author that this class is caught, then not catching it. */
export type TierVacuousKey = "tool_not_called" | "subagent_tool_absent";

/** The load-time refusal text. Names what is wrong, why it can never hold, what to write instead, and —
 *  because an author will meet it — that `tool_called` behaves differently. */
export function tierVacuousMessage(f: TierVacuousFinding, key: TierVacuousKey, context: string): string {
  const remedy =
    f.instead === null
      ? `The \`${f.tier}\` tier removes \`${f.tool}\` outright, so there is no replacement to assert — drop this assertion.`
      : `Assert \`${key}: "${f.instead}"\` instead: that is the tool \`${f.tier}\` actually serves in its place.`;
  return (
    `${context}: \`${key}: "${f.tool}"\` can never be violated at fidelity \`${f.tier}\` — that tier does not ` +
    `serve \`${f.tool}\` at all, so the assertion passes vacuously and verifies nothing. ${remedy}\n` +
    `The positive sibling is NOT refused: \`tool_called: "${f.tool}"\` fails normally, which is a legible red ` +
    `rather than a false green.`
  );
}
