// Guards against a `docs/*.md` pointer inside the shipped skill payload (.claude/skills/**) that
// resolves nowhere for a PLUGIN-install consumer. A Claude Code plugin cache materializes ONLY
// `.claude/skills/<name>/**` — `docs/` ships in the npm tarball (see package.json `files`), not the
// plugin payload — so a bare relative reference like `docs/critique.md` is a dead pointer for every
// plugin-install user, even though it resolves fine for an npm/tarball install. This cost a real
// consumer hours (they needed `critique-evidence-package.txt`'s name, documented only in
// docs/critique.md) and shipped unfixed across two releases before this check existed.
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

// A full GitHub blob permalink for a docs/*.md file, e.g.
// `https://github.com/yaniv-golan/cowork-harness/blob/main/docs/critique.md` — this resolves
// regardless of install path, so any occurrence of it is exempt from the bare-reference check below.
const PERMALINK_RE = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/blob\/[^\s)]+\/docs\/(?:[\w-]+\/)*[\w-]+\.md/g;

// A markdown link `[text](permalink)` whose target is one of the permalinks above — stripped as a
// whole unit FIRST, because the link text itself is often the same bare `docs/x.md` string (e.g.
// `` [`docs/critique.md`](https://…/docs/critique.md) ``) and must not separately trip the bare check.
const MD_LINK_TO_DOCS_RE = /\[[^\]\n]*\]\(https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/blob\/[^\s)]+\/docs\/(?:[\w-]+\/)*[\w-]+\.md\)/g;

// A bare/relative reference to a docs/*.md page, anywhere it isn't already covered by a permalink —
// this is the dead pointer for a plugin install.
// Nested segments included: a reference to a doc in a SUBDIRECTORY of docs/ is just as dead as
// `docs/critique.md`, and a pattern that only matched the flat form would let the next one through.
const BARE_DOC_RE = /docs\/(?:[\w-]+\/)*[\w-]+\.md/g;

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
      // Strip whole markdown-link-to-permalink constructs, then any remaining bare permalink (the
      // YAML/Python-comment case, where the URL appears with no surrounding [text](...) brackets).
      const residual = lineText.replace(MD_LINK_TO_DOCS_RE, "").replace(PERMALINK_RE, "");
      const matches = residual.match(BARE_DOC_RE);
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
      `${v.file}:${v.line}: bare reference to "${v.target}" — dead for a plugin install (docs/ ships ` +
      `only in the npm tarball, not the plugin cache); rewrite to a GitHub blob permalink ` +
      `(https://github.com/yaniv-golan/cowork-harness/blob/main/${v.target})`,
  );
  return { ok: violations.length === 0, errors, violations };
}

function main(): void {
  const { ok, errors, violations } = checkSkillDocLinks();
  if (ok) {
    process.stdout.write("✓ no dangling docs/*.md references under .claude/skills/**\n");
    return;
  }
  process.stdout.write(`found ${violations.length} dangling docs/*.md reference(s):\n`);
  for (const e of errors) process.stderr.write(`::error::${e}\n`);
  process.exitCode = 1;
}

// Run only when invoked directly (so a test can import findViolations/checkSkillDocLinks without
// side effects) — same convention as check-versions.ts / check-baseline-staleness.ts.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
