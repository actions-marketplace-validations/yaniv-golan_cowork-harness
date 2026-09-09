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
