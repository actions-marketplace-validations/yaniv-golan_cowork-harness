// Guards against a pointer to a repo directory the shipped skill payload (.claude/skills/**) cannot
// reach. A Claude Code plugin cache materializes ONLY `.claude/skills/<name>/**`, so a bare relative
// reference like `docs/critique.md`, `schema/run-result.json` or `examples/answer-policies/demo.yaml`
// is a dead pointer for every plugin-install user, even where it resolves fine for an npm/tarball
// install. This cost a real consumer hours (they needed `critique-evidence-package.txt`'s name,
// documented only in docs/critique.md) and shipped unfixed across two releases before this check
// existed. See DEAD_ROOTS below for which roots are in scope and, just as importantly, which are not.
//
//   npx tsx scripts/check-skill-doc-links.ts
//
// Fix for a violation: rewrite the bare `docs/x.md` into a GitHub blob permalink
// (https://github.com/<owner>/<repo>/blob/main/docs/x.md) so it resolves regardless of install
// path — see the many examples already in .claude/skills/cowork-harness/SKILL.md and references/.
//
// Scope: git-TRACKED files under .claude/skills/** only. This is deliberately the same boundary a
// plugin marketplace install and the harness's own `local_plugins` staging use — an untracked file
// under .claude/skills/ never ships either (see a plugin install materializes only `.claude/skills/<name>/**`), so
// `git ls-files` is the correct enumeration, not a raw directory walk. It also has the side effect of
// excluding gitignored scratch dirs like `.claude/skills/*-workspace/` for free.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Repo roots that exist in the REPO but never in a PLUGIN cache, so a bare relative pointer to one is
// dead for every plugin-install consumer. Deliberately NOT exhaustive:
//   scripts/   — the payload ships its own .claude/skills/<name>/scripts/, so the path resolves
//   cassettes/ — in a recipe this names the READER's directory, not ours
//   src/, test/ — provenance citations ("the rule lives here"), not "go open this"
//   baselines/ — its only payload occurrence is a glob no filename pattern should match
// Nested segments are included: a reference into a SUBDIRECTORY is just as dead as a flat one, and a
// pattern that only matched the flat form would let the next one through.
const DEAD_ROOTS = ["docs", "schema", "examples"] as const;
const DEAD_PATH_BODY = `(?:${DEAD_ROOTS.join("|")})/(?:[\\w.-]+/)*[\\w.-]+\\.(?:md|json|ya?ml)`;

// A full GitHub blob permalink to one of those paths, e.g.
// `https://github.com/yaniv-golan/cowork-harness/blob/main/docs/critique.md` — this resolves
// regardless of install path, so any occurrence of it is exempt from the bare-reference check below.
const PERMALINK_RE = new RegExp(`https://github\\.com/[\\w.-]+/[\\w.-]+/blob/[^\\s)]+/${DEAD_PATH_BODY}`, "g");

// A markdown link `[text](permalink)` whose target is one of the permalinks above — stripped as a
// whole unit FIRST, because the link text itself is often the same bare path (e.g.
// `` [`docs/critique.md`](https://…/docs/critique.md) ``) and must not separately trip the bare check.
const MD_LINK_TO_DEAD_RE = new RegExp(`\\[[^\\]\\n]*\\]\\(https://github\\.com/[\\w.-]+/[\\w.-]+/blob/[^\\s)]+/${DEAD_PATH_BODY}\\)`, "g");

// A bare/relative reference to one of those paths, anywhere it isn't already covered by a permalink —
// this is the dead pointer for a plugin install.
const BARE_DEAD_RE = new RegExp(DEAD_PATH_BODY, "g");

// Explicit, greppable per-line opt-out for a pointer the SAME sentence already qualifies as npm-only
// (e.g. "published as `schema/verify-cassettes.json` in the npm package"). Mirrors lint-skill's
// `ignore-next-line` convention: an escape hatch visible in the source, never a silent heuristic over
// surrounding prose. Line-scoped by design — a file-wide opt-out would hide the next real one.
const OPT_OUT_MARKER = "<!-- npm-only-ok -->";

export interface Violation {
  file: string;
  line: number;
  target: string;
}

/**
 * Pure scan over in-memory file contents — no git/filesystem access, so a test can feed a synthetic
 * fixture without touching the real tree.
 */
export function findViolations(files: Array<{ path: string; content: string }>): Violation[] {
  const violations: Violation[] = [];
  for (const { path, content } of files) {
    const lines = content.split("\n");
    lines.forEach((lineText, i) => {
      if (lineText.includes(OPT_OUT_MARKER)) return;
      // Strip whole markdown-link-to-permalink constructs, then any remaining bare permalink (the
      // YAML/Python-comment case, where the URL appears with no surrounding [text](...) brackets).
      const residual = lineText.replace(MD_LINK_TO_DEAD_RE, "").replace(PERMALINK_RE, "");
      const matches = residual.match(BARE_DEAD_RE);
      if (matches) {
        for (const target of matches) violations.push({ file: path, line: i + 1, target });
      }
    });
  }
  return violations;
}

/**
 * Lists git-tracked files under .claude/skills/** — see the module comment for why tracked-only is
 * the right boundary (matches what a plugin install and `local_plugins` staging both materialize).
 */
export function listTrackedSkillFiles(repoRoot: string = REPO_ROOT): string[] {
  const out = execFileSync("git", ["ls-files", "--", ".claude/skills"], { cwd: repoRoot, encoding: "utf8" });
  return out.split("\n").filter((l) => l.trim().length > 0);
}

export function checkSkillDocLinks(repoRoot: string = REPO_ROOT): { ok: boolean; errors: string[]; violations: Violation[] } {
  const relPaths = listTrackedSkillFiles(repoRoot);
  const files = relPaths.map((rel) => ({ path: rel, content: readFileSync(join(repoRoot, rel), "utf8") }));
  const violations = findViolations(files);
  const errors = violations.map(
    (v) =>
      `${v.file}:${v.line}: bare reference to "${v.target}" — dead for a plugin install, which ` +
      `materializes only .claude/skills/<name>/** (and some of these paths are not in the npm tarball ` +
      `either — package.json \`files\` ships only examples/replays); rewrite to a GitHub blob permalink ` +
      `(https://github.com/yaniv-golan/cowork-harness/blob/main/${v.target}), or append ` +
      `"${OPT_OUT_MARKER}" to the line if its own sentence already qualifies the pointer as npm-only`,
  );
  return { ok: violations.length === 0, errors, violations };
}

function main(): void {
  const { ok, errors, violations } = checkSkillDocLinks();
  if (ok) {
    process.stdout.write(`✓ no dangling ${DEAD_ROOTS.join("/")}/ references under .claude/skills/**\n`);
    return;
  }
  process.stdout.write(`found ${violations.length} dangling repo-path reference(s):\n`);
  for (const e of errors) process.stderr.write(`::error::${e}\n`);
  process.exitCode = 1;
}

// Run only when invoked directly (so a test can import findViolations/checkSkillDocLinks without
// side effects) — same convention as check-versions.ts / check-baseline-staleness.ts.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
