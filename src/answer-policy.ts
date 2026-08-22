// Shape validation for an `--answer-policy <yaml>` document, extracted leaf-only so it is testable
// without importing `cli.ts` (which calls `main()` at module scope).
import { AnswerRule } from "./types.js";

export type AnswerPolicyResult = { rules: AnswerRule[] } | { error: string };

/** Validate a PARSED answer-policy document (bare list, or `{answers: [...]}`) into rules. */
export function parseAnswerPolicyDoc(parsed: unknown): AnswerPolicyResult {
  // Accept exactly two shapes: a bare list, or an object with an OWN `answers` array.
  //
  // The previous form was `Array.isArray(parsed) ? parsed : (parsed?.answers ?? [])`, which turned every
  // other mapping into `[]` — a value that then PASSES the array check and validates as zero rules. A
  // document keyed `answer:` (one character off) was therefore accepted as an empty policy, and the author
  // discovered it only when a gate went unanswered mid-run, having already spent tokens.
  //
  // `Object.hasOwn`, not `?.answers`: the latter walks the prototype chain, so an inherited `answers`
  // would read as authored.
  let rules: unknown;
  if (Array.isArray(parsed)) {
    rules = parsed;
  } else if (typeof parsed === "object" && parsed !== null && Object.hasOwn(parsed, "answers")) {
    rules = (parsed as { answers: unknown }).answers;
  } else {
    // Name the keys the author ACTUALLY typed. They need to see their own `answer:`, not be told what the
    // correct spelling would have been and left to spot the difference.
    const found =
      typeof parsed === "object" && parsed !== null
        ? `top-level key(s): ${Object.keys(parsed).join(", ") || "(none)"}`
        : `got ${parsed === null ? "null" : typeof parsed}`;
    return { error: `must be a list of rules, or a mapping with an \`answers:\` list — ${found}` };
  }
  if (!Array.isArray(rules)) return { error: `\`answers:\` must be a list of rules, got ${rules === null ? "null" : typeof rules}` };
  const out: AnswerRule[] = [];
  for (const [idx, raw] of (rules as unknown[]).entries()) {
    const r = AnswerRule.safeParse(raw);
    if (!r.success)
      return {
        error: `rule #${idx + 1} is malformed: ${r.error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; ")}`,
      };
    out.push(r.data);
  }
  return { rules: out };
}
