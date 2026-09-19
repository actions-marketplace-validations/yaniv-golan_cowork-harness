import { readFileSync, realpathSync, readdirSync } from "node:fs";
import { join, resolve, dirname, basename, relative } from "node:path";
import { listSkillFilesRecursive } from "./corpus-walk.js";
import { readPluginName, type ResolvedAgent } from "./resolve-agents.js";

/** One plugin-root reference resolved for packaging. TWO keys per file, deliberately:
 *  `rel` is the only spelling `gitAccept` can match (`gitTrackedSet` runs `git ls-files` at the plugin
 *  root, so its keys are root-relative POSIX and never contain `..`), while `displayKey` is what reaches
 *  `corpusEntries`, the allocator, `corpusCuts`, `corpusPackaged` and `corpusExcluded`. Using one string
 *  for both — as the agents path does — collides here, because `references/` exists under BOTH the plugin
 *  root and the skill dir and the two would render indistinguishably. */
export interface ResolvedReference {
  rel: string;
  absPath: string;
  displayKey: string;
  /** WHY this file is in the corpus: `<file>:<line>`, `agent:<name>:<line>`, or `read-by-agent`. */
  via: string;
}

export type OmissionReason = "not-linked" | "not-utf8" | "ambiguous-read";

export interface RootReferenceResolution {
  packaged: ResolvedReference[];
  omitted: Array<{ name: string; reason: OmissionReason }>;
}

/** Valid UTF-8, decided by the decoder rather than by scanning the decoded string. `fatal: true` throws
 *  iff the bytes are not valid UTF-8 — which is the actual question. A "no U+FFFD in the output" check
 *  cannot tell a decode FAILURE from a document that legitimately CONTAINS that character (a doc about
 *  encodings, or this repo's own redaction markers), and would label such a file "it is a binary". */
function isCleanUtf8(absPath: string): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(absPath));
    return true;
  } catch {
    return false;
  }
}

/** Trailing punctuation a prose or markdown token picks up. Stripped as a RUN and WITHOUT requiring
 *  balance: the real links this must handle end `…skill-execution-model.md): one of three` and
 *  `…skill-execution-model.md).`, i.e. a lone unmatched `)` that a paired-bracket strip leaves attached. */
const TRAILING_PUNCT = /[)\]}>.,;:!?'"]+$/;

/** Candidate tokens on one line: backticked spans, markdown/href link targets, and bare whitespace-
 *  delimited runs. Only those containing a separator are resolved as paths (step 1); the bare ones matter
 *  for the ARMED basename pass (step 5). */
function lineTokens(line: string): { pathish: string[]; bare: string[] } {
  const pathish: string[] = [];
  const bare: string[] = [];
  const raw = [
    ...[...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]!),
    ...[...line.matchAll(/\]\(([^)\s]+)/g)].map((m) => m[1]!),
    ...[...line.matchAll(/href=["']([^"']+)["']/g)].map((m) => m[1]!),
    ...line.split(/\s+/),
  ];
  for (const t0 of raw) {
    const t = t0
      .replace(/[#?].*$/, "")
      .replace(/^["'<([]+/, "")
      .replace(TRAILING_PUNCT, "")
      .split("\\")
      .join("/");
    if (!t) continue;
    if (t.includes("/")) pathish.push(t);
    else bare.push(t);
  }
  return { pathish, bare };
}

/** Resolve one path-ish token to an absolute host path, or undefined when it is not addressable.
 *  `${CLAUDE_PLUGIN_ROOT}` and a leading `<pluginName>/` both mean the plugin root; everything else is
 *  relative to the directory of the file the token was found in — which is what makes a bare
 *  `references/x.md` mean the SKILL's own references and not the root's, with no special case. */
function tokenToAbs(token: string, pluginRoot: string, pluginName: string, fileDir: string): string | undefined {
  if (token.includes("${CLAUDE_PLUGIN_ROOT}")) return resolve(token.replace("${CLAUDE_PLUGIN_ROOT}", pluginRoot));
  if (token.startsWith(`${pluginName}/`)) return resolve(join(pluginRoot, token.slice(pluginName.length + 1)));
  return resolve(fileDir, token);
}

/** Every root reference one source file points at, with the line it was pointed at from.
 *
 *  The ARMING rule (step 4) is what the prefix-matching designs got wrong: the dominant real form is
 *
 *      From `${CLAUDE_PLUGIN_ROOT}/references/` (shared): `stage-expectations.md`, `benchmarks.md`, …
 *
 *  where the only token carrying a separator is the DIRECTORY and the filenames are bare. A token that
 *  resolves to the references directory therefore arms bare-basename matching for THAT LINE ONLY — it
 *  never recurses (which would silently re-implement wholesale packaging) and does not carry to the next
 *  line (which would pull in a following skill-local list whose basenames happen to collide). */
function linksIn(
  text: string,
  fileDir: string,
  pluginRoot: string,
  pluginName: string,
  byBasename: Map<string, string>,
  byRealpath: Map<string, string>,
): Map<string, number> {
  const refsDir = (() => {
    try {
      return realpathSync(join(pluginRoot, "references"));
    } catch {
      return undefined;
    }
  })();
  const hits = new Map<string, number>(); // rel -> 1-based line
  if (refsDir === undefined) return hits;
  text.split(/\r?\n/).forEach((line, i) => {
    const { pathish, bare } = lineTokens(line);
    let armed = false;
    for (const t of pathish) {
      const abs = tokenToAbs(t, pluginRoot, pluginName, fileDir);
      if (abs === undefined) continue;
      let rp: string;
      try {
        rp = realpathSync(abs); // realpath BOTH sides: a symlink must not escape the references tree
      } catch {
        continue; // most prose tokens are not paths at all
      }
      if (rp === refsDir) {
        armed = true;
        continue;
      }
      // Match by REALPATH IDENTITY against the walk's own entries, never by reconstructing its spelling
      // from the token. A case-only difference on a case-insensitive filesystem, or a
      // `references/alias.md -> real.md` symlink, resolves fine here but would not reproduce the walked
      // rel — and the file would then be reported `not-linked`, an actively wrong reason in the one
      // report field the narrow selection rule depends on being truthful.
      const known = byRealpath.get(rp);
      if (known !== undefined && !hits.has(known)) hits.set(known, i + 1);
    }
    if (!armed) return;
    for (const b of bare) {
      const rel = byBasename.get(b);
      if (rel !== undefined && !hits.has(rel)) hits.set(rel, i + 1);
    }
  });
  return hits;
}

/** The plugin-root references the graded skill's authored text points the agent at.
 *
 *  Mounted-but-absent is NOT the defect this implements — `scripts/` is mounted and deliberately outside
 *  the corpus (docs/critique.md), and the mount dwarfs the ceiling. The defect is narrower: a root
 *  reference the skill's own text, or a sub-agent body already in the corpus, points at IS authored
 *  guidance for that skill and was invisible to the evaluator.
 *
 *  Packaging the whole tree was measured and rejected: it inflates a binary through UTF-8 decoding, makes
 *  the allocator cut the graded skill's own SKILL.md, and — worse — feeds the evaluator another skill's
 *  shared docs, which `already-covered` judges by PRESENCE with no notion of authorship, silently
 *  converting a real gap into an excused one. */
export function resolveRootReferences(opts: {
  pluginRoot: string;
  skillDir: string;
  agents: ResolvedAgent[];
  /** Turn-1 reference accesses (`read` channel is the only one used — see clause 3). */
  accesses?: Array<{ path: string; via: string[] }>;
  /** The packager's corpus==mount predicate, keyed on PLUGIN-ROOT-relative paths. Link EVIDENCE must obey
   *  the same rule as packaging: a root reference linked only from an untracked agent body or an
   *  untracked skill reference was linked by content staging never delivered, so the agent never saw the
   *  pointer. Omitted (or `null` for a non-work-tree) means accept everything, matching `corpusAcceptFor`. */
  accept?: ((relFromPluginRoot: string) => boolean) | null;
}): RootReferenceResolution {
  const { pluginRoot, skillDir, agents } = opts;
  // SKIP (not "dedupe") the standalone-skill shape: those files are already packaged as skill-local, and
  // running this pass too would list the same file in `corpusPackaged` AND in `corpusOmitted` as
  // not-linked — one report contradicting itself.
  try {
    if (realpathSync(pluginRoot) === realpathSync(skillDir)) return { packaged: [], omitted: [] };
  } catch {
    if (resolve(pluginRoot) === resolve(skillDir)) return { packaged: [], omitted: [] };
  }
  const refsRoot = join(pluginRoot, "references");
  const all = listSkillFilesRecursive(refsRoot).map((r) => ({ rel: `references/${r}`, absPath: join(refsRoot, r) }));
  if (all.length === 0) return { packaged: [], omitted: [] };
  // No manifest → `readPluginName` is undefined, so rule 2's `<pluginName>/` prefix cannot fire; the
  // display key still needs a stable prefix, so fall back to the root's own directory name.
  const pluginName = readPluginName(pluginRoot) ?? basename(pluginRoot);
  const byBasename = new Map(all.map((f) => [basename(f.rel), f.rel]));
  const byRealpath = new Map<string, string>();
  for (const f of all) {
    try {
      byRealpath.set(realpathSync(f.absPath), f.rel);
    } catch {
      continue;
    }
  }

  // clauses 1 + 2 — the skill's own authored text, and the sub-agent bodies already in the corpus
  const linked = new Map<string, string>(); // rel -> via
  const record = (rel: string, via: string): void => {
    if (!linked.has(rel)) linked.set(rel, via);
  };
  const skillMd = join(skillDir, "SKILL.md");
  const sources: Array<{ label: string; absPath: string }> = [{ label: "SKILL.md", absPath: skillMd }];
  const localRefRoot = join(skillDir, "references");
  for (const r of listSkillFilesRecursive(localRefRoot)) sources.push({ label: `references/${r}`, absPath: join(localRefRoot, r) });
  for (const a of agents) sources.push({ label: `agent:${a.name}`, absPath: a.absPath });
  const acceptSource = (absPath: string): boolean => {
    if (!opts.accept) return true;
    const rel = relative(pluginRoot, absPath).split("\\").join("/");
    return rel.startsWith("..") ? true : opts.accept(rel); // outside the root: not ours to filter
  };
  for (const src of sources) {
    if (!acceptSource(src.absPath)) continue;
    let text: string;
    try {
      text = readFileSync(src.absPath, "utf8");
    } catch {
      continue;
    }
    for (const [rel, line] of linksIn(text, dirname(src.absPath), pluginRoot, pluginName, byBasename, byRealpath))
      record(rel, `${src.label}:${line}`);
  }

  // clause 3 — read during the graded turn. `skillReferenceReadPath` strips everything before the
  // leftmost `/references/`, so a read key is AMBIGUOUS between the two trees and needs this mapping.
  // Undefined `accesses` means the run recorded nothing observable; clause 3 then contributes nothing,
  // and nothing downstream may claim otherwise.
  const ambiguous: string[] = [];
  // EVERY skill's references/, not just the graded skill's. `skillReferenceReadPath` strips at the
  // leftmost `/references/`, so a read of `skills/OTHER/references/shared.md` also arrives as
  // `references/shared.md` — and the whole plugin is mounted, so that read really can happen. Comparing
  // against the graded skill alone let a SIBLING's read pull the root file's content into this skill's
  // corpus, with no ambiguity flag, on evidence about a different file.
  const localRels = new Set<string>();
  for (const r of listSkillFilesRecursive(localRefRoot)) localRels.add(`references/${r}`);
  let siblingRefDirs: string[] = [];
  try {
    siblingRefDirs = readdirSync(join(pluginRoot, "skills"), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(pluginRoot, "skills", e.name, "references"));
  } catch {
    siblingRefDirs = [];
  }
  for (const dir of siblingRefDirs) for (const r of listSkillFilesRecursive(dir)) localRels.add(`references/${r}`);
  for (const a of opts.accesses ?? []) {
    if (!a.via.includes("read")) continue; // `bash`/`grep` are weaker evidence — see evaluator.ts
    const isRoot = all.some((f) => f.rel === a.path);
    if (!isRoot) continue; // a sibling skill's reference, or not a reference at all
    if (localRels.has(a.path)) {
      if (!linked.has(a.path)) ambiguous.push(a.path); // same spelling in both trees — cannot attribute
      continue;
    }
    record(a.path, "read-by-agent");
  }

  const packaged: ResolvedReference[] = [];
  const omitted: Array<{ name: string; reason: OmissionReason }> = [];
  for (const f of all) {
    const displayKey = `${pluginName}/${f.rel}`;
    const via = linked.get(f.rel);
    if (via === undefined) {
      omitted.push({ name: displayKey, reason: ambiguous.includes(f.rel) ? "ambiguous-read" : "not-linked" });
      continue;
    }
    // Link-first, THEN utf8: an unlinked file is never read, so a large unlinked tree costs nothing.
    if (!isCleanUtf8(f.absPath)) {
      omitted.push({ name: displayKey, reason: "not-utf8" });
      continue;
    }
    packaged.push({ rel: f.rel, absPath: f.absPath, displayKey, via });
  }
  packaged.sort((a, b) => a.displayKey.localeCompare(b.displayKey));
  omitted.sort((a, b) => a.name.localeCompare(b.name));
  return { packaged, omitted };
}
