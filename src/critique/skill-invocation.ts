/**
 * Matching a critique's `--skill` selector against an OBSERVED skill id, and deciding which
 * invocation channels a graded run actually lets us observe.
 *
 * The match used to be `JSON.stringify(skillActivity).includes(name)`, which scanned tool names and
 * JSON keys as well as ids: measured against a real run with zero invocations, selectors `fetch`,
 * `root` and `skill` all reported `true`, and `root` collided with the `(root)` sentinel itself.
 * Match ids structurally instead.
 */

/** The two sentinels `TimelineWriter`/`foldSkillActivity` emit for un-attributed activity
 *  (`src/agent/timeline.ts`, `src/run/timeline-fold.ts`). Parenthesized precisely so they cannot
 *  collide with a real id — honour that here. */
const SENTINELS = new Set(["(root)", "(unknown)"]);

/** Reduce a selector to the bare skill-directory name. `resolveCritiquedSkillDir` validates the
 *  selector by `join(skillFolder, "skills", selector)`, and `path.join` normalizes — so
 *  `./deck-review`, `deck-review/` and `skills/../deck-review` all name the same directory on disk and
 *  must compare equal here. Splits on path separators ONLY: a colon is a plugin qualifier, not a
 *  separator, and must survive. */
export function normalizeSkillSelector(selector: string): string {
  const parts = selector.split(/[/\\]+/).filter((p) => p !== "" && p !== ".");
  return parts.length ? parts[parts.length - 1] : selector;
}

/** Does an observed skill id name the selected skill? An id is either bare (`deck-review`) or
 *  plugin-qualified (`founder-skills:deck-review`) — both forms occur in the corpus — so accept the
 *  exact id and the `<plugin>:<name>` suffix, and nothing looser. `deck-review-lite` must NOT match
 *  `deck-review`, which is exactly what a substring test got wrong. */
export function matchesSkillId(observedId: string, selector: string): boolean {
  if (SENTINELS.has(observedId)) return false;
  const want = normalizeSkillSelector(selector);
  if (observedId === want || observedId === selector) return true;
  const colon = observedId.lastIndexOf(":");
  return colon !== -1 && observedId.slice(colon + 1) === want;
}

/** What a prompt's leading slash token turned out to be. `unobservable` means the run did not record
 *  what we would need (an older `result.json` with no prompt, or an init frame that delivered no skill
 *  inventory) — distinct from `none`, which is a real negative. */
export type SlashInvocation = { kind: "skill"; id: string } | { kind: "none" } | { kind: "unobservable" };

/** Did this prompt invoke a STAGED SKILL by slash command?
 *
 *  Only the LEADING token counts: the binary expands a slash command in first position, and a `/foo`
 *  mid-sentence is prose. The match is against the init frame's SKILL inventory, never against
 *  `slash_commands` — that list mixes plugin commands with auto-registered skills and carries no
 *  distinguisher, so keying off it accepts `founder-skills:feedback` and
 *  `creative-problem-solving:ideas` (both verified real, both plain commands) as skill invocations.
 *  Trailing sentence punctuation is excluded from the captured token so `/plugin:skill.` resolves. */
export function slashCommandSkillInvocation(
  prompt: string | undefined,
  availableSkills: readonly { id: string }[] | undefined,
): SlashInvocation {
  if (prompt === undefined || availableSkills === undefined) return { kind: "unobservable" };
  const m = /^\s*\/([A-Za-z0-9_.:-]*[A-Za-z0-9_:-])/.exec(prompt);
  if (!m) return { kind: "none" };
  const ids = new Set(availableSkills.map((s) => s.id));
  return ids.has(m[1]) ? { kind: "skill", id: m[1] } : { kind: "none" };
}

/** Did the turn's timeline contain a `Skill` call we could not attribute to any skill?
 *
 *  A `Skill` tool_use with a `parentToolUseId` is a sub-agent's own invocation. `run.ts`'s
 *  `isMainAgentFlow` gate drops it and `timeline.ts`'s sticky window ignores it, so it reaches no
 *  `skillActivity` entry — and the timeline records no tool `input`, so its skill NAME is
 *  unrecoverable from a graded result. Seeing one means "a skill ran somewhere we cannot name", which
 *  is enough to refuse a negative verdict and not enough to assert a positive one. */
export function hasUnattributableSkillCall(timelineJsonl: string): boolean {
  for (const line of timelineJsonl.split("\n")) {
    if (!line.trim()) continue;
    let e: { type?: unknown; name?: unknown; parentToolUseId?: unknown };
    try {
      e = JSON.parse(line) as typeof e;
    } catch {
      continue; // a torn final line is normal on an append-only stream; never fail the critique on it
    }
    if (e.type === "tool_use" && e.name === "Skill" && typeof e.parentToolUseId === "string") return true;
  }
  return false;
}

/** critique's `skillInvocationObserved`, as a tri-state.
 *
 *  `true`  — a channel we can observe named the selected skill.
 *  `false` — every channel was observable and none did.
 *  `undefined` — a channel could not be observed, so a negative would be an unsupportable claim
 *                rather than a finding. Absent is never a synonym for "no".
 *
 *  `commandShadowsSkill` is the undecidable case: a plugin shipping BOTH `commands/<n>.md` and
 *  `skills/<n>/SKILL.md` registers one slash entry and the run does not say which ran
 *  (`vercel@0.48.0` does exactly this). Report absent rather than guess. */
export function observedSkillInvocation(
  selector: string,
  skillActivity: ReadonlyArray<{ skillId?: unknown }> | undefined,
  slash: SlashInvocation,
  commandShadowsSkill: boolean,
  unattributableSkillCall: boolean,
): boolean | undefined {
  const viaTool = skillActivity?.some((e) => typeof e?.skillId === "string" && matchesSkillId(e.skillId, selector));
  if (viaTool) return true;
  if (slash.kind === "skill" && matchesSkillId(slash.id, selector)) return commandShadowsSkill ? undefined : true;
  if (skillActivity === undefined || slash.kind === "unobservable") return undefined;
  // A skill ran inside a sub-agent and the record cannot name it — "not this skill" is unsupportable.
  if (unattributableSkillCall) return undefined;
  return false;
}
