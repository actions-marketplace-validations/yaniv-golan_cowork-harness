// Assertion-coverage prober: perturbs recorded artifact leaves and hands the caller a plan of "if this
// value had been wrong, would ANYTHING have caught it" probes. This module only PLANS and APPLIES —
// it never runs assertions or touches disk. The replay layer re-runs the assertion suite once per
// Mutation and reports which ones came back green anyway (an uncaught perturbation = an unverified field).
//
// Why this exists: a 21-cassette corpus once had seven scenarios whose assertions were satisfied by
// (almost) any output — discovered only by a throwaway script that flipped values by hand. This module
// is that script, made repeatable and bounded.

export interface Mutation {
  /** artifact path as recorded in the cassette, e.g. "outputs/metrics.json" */
  file: string;
  /** dotted path to the perturbed leaf, e.g. "totals.revenue" or "rows.0.currency" */
  path: string;
  before: unknown;
  after: unknown;
  /** one-line human label, e.g. `outputs/metrics.json  totals.revenue: 42 → 43` */
  label: string;
}

interface PlanOptions {
  maxPerFile?: number;
  maxTotal?: number;
}

const DEFAULT_MAX_PER_FILE = 10;
const DEFAULT_MAX_TOTAL = 50;

// Cannot occur naturally in recorded output, so a `!== "__MUTATED__"`-shaped check (or any assertion
// that greps recorded content) is far more likely to trip than on an empty string. Empty string is a
// WEAKER sentinel: a "not blank" check is rare, but a content/substring check is common, and only the
// distinctive-token approach reliably defeats both.
const STRING_SENTINEL = "__MUTATED__";

/** One leaf found while walking a parsed JSON document, before mutation-planning decides whether it's
 *  usable (null leaves and unrepresentable paths are dropped by the caller, not here — kept separate so
 *  the walk itself stays a pure structural traversal). */
interface Leaf {
  path: string;
  value: unknown;
}

// Object.keys() order is insertion order for string keys (the only kind JSON.parse produces), so no
// explicit sort is needed for determinism there. Arrays are walked by numeric index, already stable.
// The one place non-determinism could sneak in is iteration order across the artifacts array itself,
// which is the CALLER's array order — we walk it as given, so the caller's own order (deterministic,
// since it comes from the cassette file) fully determines ours.
function walkLeaves(value: unknown, prefix: string, out: Leaf[]): void {
  if (value === null || typeof value !== "object") {
    out.push({ path: prefix, value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => walkLeaves(item, prefix === "" ? String(i) : `${prefix}.${i}`, out));
    return;
  }
  for (const key of Object.keys(value as Record<string, unknown>)) {
    // A key containing "." would make the dotted path ambiguous with a nested-object path (e.g. key
    // "a.b" at top level collides with path "a" -> object -> key "b"), so such leaves are unrepresentable
    // and must be skipped rather than silently mislabeled.
    if (key.includes(".")) continue;
    walkLeaves((value as Record<string, unknown>)[key], prefix === "" ? key : `${prefix}.${key}`, out);
  }
}

function perturb(value: unknown): { after: unknown } | undefined {
  if (value === null) return undefined; // ambiguous: "was this a real value?" — skip per spec.
  if (typeof value === "number") {
    // NaN/Infinity can't be represented in JSON — such a leaf couldn't have been parsed from JSON text,
    // so this branch is unreachable for real cassette data, but guard anyway rather than emit NaN.
    if (!Number.isFinite(value)) return undefined;
    return { after: value + 1 };
  }
  if (typeof value === "string") {
    // Guard against the sentinel already being the recorded value (unlikely, but then +0 mutation would
    // be a no-op and falsely "detectable").
    if (value === STRING_SENTINEL) return { after: `${STRING_SENTINEL}_2` };
    return { after: STRING_SENTINEL };
  }
  if (typeof value === "boolean") {
    return { after: !value };
  }
  // undefined leaves don't occur in JSON.parse output; any other typeof (function/symbol/bigint) is
  // likewise impossible from JSON — skip defensively rather than throw.
  return undefined;
}

/** Attempts JSON.parse; returns undefined (never throws) for non-JSON or unparseable bodies, so the
 *  planner can silently skip artifacts that aren't perturbable. */
function tryParseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/** Pre-truncation eligible-leaf count per file, keyed by artifact path. Exposed so a caller can detect
 *  truncation (`eligibleLeafCounts(file) > mutations-for-that-file.length`, or compare against
 *  maxPerFile/maxTotal directly) WITHOUT re-walking the document itself. Silent truncation would let a
 *  coverage report read "everything is covered" when most fields were never tried — this makes the gap
 *  discoverable by construction rather than by the caller remembering to re-derive it. */
export function planMutationsWithStats(
  artifacts: { path: string; body: string }[],
  opts?: PlanOptions,
): { mutations: Mutation[]; eligibleLeafCounts: Record<string, number>; truncatedTotal: boolean } {
  const maxPerFile = opts?.maxPerFile ?? DEFAULT_MAX_PER_FILE;
  const maxTotal = opts?.maxTotal ?? DEFAULT_MAX_TOTAL;

  const mutations: Mutation[] = [];
  const eligibleLeafCounts: Record<string, number> = {};
  let truncatedTotal = false;

  // Artifacts are walked in the order given (the cassette's own recorded order) — never sorted or
  // re-keyed — so re-running planMutations on the same array always yields the same plan in the same
  // order, satisfying the determinism requirement without any extra bookkeeping.
  for (const artifact of artifacts) {
    if (!artifact.path.toLowerCase().endsWith(".json")) continue;
    // Defensive: the declared type says body is always a string, but a caller feeding real cassette
    // artifacts straight through (some are recorded `truncated: true` with no `body` at all) can hand
    // us `undefined` at runtime. Skip rather than let JSON.parse(undefined) throw "SyntaxError:
    // Unexpected token u" and take the whole plan down for an unrelated file.
    if (typeof artifact.body !== "string") continue;
    const parsed = tryParseJson(artifact.body);
    if (parsed === undefined) continue; // non-JSON, or a JSON literal `null`/`undefined` body — nothing to perturb.

    const leaves: Leaf[] = [];
    walkLeaves(parsed, "", leaves);

    let eligible = 0;
    let takenForFile = 0;
    for (const leaf of leaves) {
      const result = perturb(leaf.value);
      if (result === undefined) continue; // null, or an unrepresentable dotted path already filtered in walkLeaves.
      eligible++;
      if (takenForFile >= maxPerFile) continue;
      if (mutations.length >= maxTotal) {
        truncatedTotal = true;
        continue;
      }
      mutations.push({
        file: artifact.path,
        path: leaf.path,
        before: leaf.value,
        after: result.after,
        label: `${artifact.path}  ${leaf.path}: ${JSON.stringify(leaf.value)} → ${JSON.stringify(result.after)}`,
      });
      takenForFile++;
    }
    eligibleLeafCounts[artifact.path] = eligible;
    if (eligible > takenForFile) truncatedTotal = true; // per-file cap also counts as truncation.
  }

  return { mutations, eligibleLeafCounts, truncatedTotal };
}

/** Glob matcher for `--mutate-include` / `--mutate-exclude`, over cassette-recorded artifact paths.
 *
 *  Deliberately its own, rather than reusing `analyze-skill`'s: that one is module-private, EXPANDS the
 *  filesystem (`readdirSync`) rather than matching a string, accepts only `dir/*.ext`-shaped patterns,
 *  and is case-insensitive. Artifact paths are recorded strings — matching them is a pure predicate, and
 *  case is meaningful.
 *
 *  `*` matches within one path segment; `**` crosses segments (so `handoff/**` scopes a whole subtree,
 *  which is the shape someone reaches for to exclude per-run internals). Every other character is
 *  literal, including regex metacharacters. */
export function matchesAnyGlob(path: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(path));
}

function globToRegExp(pattern: string): RegExp {
  // Split on the ** token first so it can be expanded to a cross-segment match; everything between is
  // escaped literally, with single `*` limited to non-separator characters.
  const body = pattern
    .split("**")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
    .join(".*");
  return new RegExp(`^${body}$`); // case-SENSITIVE by construction
}

/** What a `--mutate` run actually sampled, and which cap stopped it.
 *
 *  `truncatedTotal` alone cannot answer the second question — despite its name, `planMutationsWithStats`
 *  also sets it when the PER-FILE cap bit. The distinction is what makes the report actionable: the
 *  per-file cap is checked before the total (see the loop above), so with a handful of artifacts the
 *  total is never reached and telling the reader to raise it would change nothing.
 *
 *  `total` takes precedence when both bound: once the total cap is reached, raising the per-file cap
 *  alone cannot yield a single extra perturbation. */
export interface MutationCoverage {
  /** perturbations the plan contains (post-cap). */
  sampled: number;
  /** eligible leaves across every artifact, BEFORE either cap. */
  eligible: number;
  truncatedBy: "per-file" | "total" | null;
  /** how many artifacts hit the per-file cap with more left — the shape of what was missed. */
  filesAtPerFileCap: number;
  caps: { perFile: number; total: number };
}

export function summarizeMutationPlan(
  stats: { mutations: Mutation[]; eligibleLeafCounts: Record<string, number> },
  opts?: PlanOptions,
): MutationCoverage {
  const perFile = opts?.maxPerFile ?? DEFAULT_MAX_PER_FILE;
  const total = opts?.maxTotal ?? DEFAULT_MAX_TOTAL;
  const eligible = Object.values(stats.eligibleLeafCounts).reduce((a, b) => a + b, 0);
  const takenPerFile = new Map<string, number>();
  for (const m of stats.mutations) takenPerFile.set(m.file, (takenPerFile.get(m.file) ?? 0) + 1);
  let filesAtPerFileCap = 0;
  for (const [file, count] of takenPerFile) if (count >= perFile && (stats.eligibleLeafCounts[file] ?? 0) > count) filesAtPerFileCap++;
  const truncatedBy: MutationCoverage["truncatedBy"] =
    stats.mutations.length >= total && eligible > stats.mutations.length ? "total" : filesAtPerFileCap > 0 ? "per-file" : null;
  return { sampled: stats.mutations.length, eligible, truncatedBy, filesAtPerFileCap, caps: { perFile, total } };
}

/** Pure planner: decides which leaves across a set of artifacts are worth perturbing, bounded by
 *  maxPerFile/maxTotal (defaults 10/50 — a full assertion-suite re-run per mutation, so cost is linear
 *  in the length of this list). Convenience wrapper over planMutationsWithStats for callers that don't
 *  need the truncation-detection metadata. */
export function planMutations(artifacts: { path: string; body: string }[], opts?: PlanOptions): Mutation[] {
  return planMutationsWithStats(artifacts, opts).mutations;
}

/** Applies one planned mutation to a JSON document's text, returning the mutated text. Pure — parses,
 *  sets the one leaf via its dotted path, re-serializes; never touches disk. Throws if `body` isn't
 *  valid JSON or `m.path` doesn't resolve in it (both indicate the mutation was planned against a
 *  different document, a caller bug we want loud rather than silently ignored). */
export function applyMutation(body: string, m: Mutation): string {
  const parsed = JSON.parse(body);
  const segments = m.path === "" ? [] : m.path.split(".");
  if (segments.length === 0) {
    // A root-level scalar document (e.g. body is just `42`) — replace it wholesale.
    return JSON.stringify(m.after, null, 2);
  }
  let cursor: Record<string, unknown> | unknown[] = parsed;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    const key = Array.isArray(cursor) ? Number(seg) : seg;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cursor = (cursor as any)[key];
    if (cursor === null || typeof cursor !== "object") {
      throw new Error(`applyMutation: path "${m.path}" does not resolve in the given body (stopped at segment "${seg}")`);
    }
  }
  const lastSeg = segments[segments.length - 1];
  const lastKey = Array.isArray(cursor) ? Number(lastSeg) : lastSeg;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (cursor as any)[lastKey] = m.after;
  return JSON.stringify(parsed, null, 2);
}

/** Explain WHY a mutation plan came out empty, from the cassette's own artifact manifest.
 *
 *  `--mutate` is diagnostic and exits 0 either way, so "no perturbable values" is the one output a
 *  reader is most likely to misread as "the feature is broken" — it looks identical whether the
 *  cassette is unsuitable, the JSON is unparseable, or the bodies were deliberately left out. Every
 *  cassette in this repo's own example corpus hits this path, so the terse form was actively
 *  misleading. `truncationReason` already records why each body is absent (`buildManifest`), so the
 *  precise remedy is derivable without re-walking anything.
 *
 *  `inlinedJsonCount` is the count of artifacts that survived the caller's own body filter AND end in
 *  `.json`; a non-zero value with an empty plan means the bodies are present but hold no perturbable
 *  leaf (empty object, or all-null). */
export function explainNoMutations(
  artifacts: { path: string; truncated?: boolean; truncationReason?: string }[],
  inlined: { path: string; body: string }[],
): string {
  const jsonAll = artifacts.filter((a) => a.path.toLowerCase().endsWith(".json"));
  const inlinedJsonCount = inlined.filter((a) => a.path.toLowerCase().endsWith(".json")).length;
  const head = "no perturbable values";
  if (jsonAll.length === 0) {
    const n = artifacts.length;
    return `${head} — this cassette records ${n} artifact(s), none of them .json. Mutation coverage perturbs recorded JSON values, so it needs a scenario whose skill writes a JSON deliverable (e.g. outputs/report.json) and an assertion over it.`;
  }
  if (inlinedJsonCount === 0) {
    // Every .json artifact is body-less. `truncationReason` names which remedy applies.
    const why = [...new Set(jsonAll.map((a) => a.truncationReason ?? "unknown"))];
    const remedy: Record<string, string> = {
      size: "over the body cap — re-record with a larger --max-artifact-bytes",
      readonly: "under a read-only mount, which is never inlined",
      input: "an upload, which is deliberately never inlined",
      unreadable: "unreadable at record time",
      unknown: "body absent for an unrecorded reason",
    };
    const detail = why.map((w) => `${w} (${remedy[w] ?? remedy.unknown})`).join(", ");
    return `${head} — ${jsonAll.length} .json artifact(s) present but none carries an inlined body: ${detail}.`;
  }
  return `${head} — ${inlinedJsonCount} inlined .json artifact(s) parsed, but none contains a perturbable leaf (an empty document, or only null values).`;
}
