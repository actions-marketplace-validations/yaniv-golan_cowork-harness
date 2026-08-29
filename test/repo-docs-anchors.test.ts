import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

// C1b: repo-docs anchor integrity.
//
// Repo docs (docs/*.md, examples/README.md) link into root README.md headings via
// `](../README.md#slug)` (and the `./README.md#…` / `README.md#…` variants where present). If a
// README heading is reworded, those anchors silently break — this test computes the GitHub
// heading-slug set for every heading in root README.md and fails if any referenced `#slug` has no
// matching heading.
//
// This is a repo-docs-only check (does not scan the skill payload — the payload-link check in
// skill-payload-links.test.ts covers that).

const README_PATH = resolve("README.md");

/** GitHub-style heading slug: lowercase; strip anything that isn't alphanumeric, space, hyphen, or
 *  UNDERSCORE; replace each whitespace char with a hyphen (runs of whitespace become runs of
 *  hyphens — NOT collapsed, matching GitHub's actual behavior for e.g. "Testing & CI/CD" ->
 *  "testing--cicd").
 *
 *  The underscore is load-bearing and was previously dropped. `github-slugger` keeps `\w`, which
 *  includes `_`, so a heading like "Static `subagent_type` resolution" anchors as
 *  `…static-subagent_type-resolution…`, NOT `…subagenttype…`. No root-README heading contains one
 *  today, which is why stripping it went unnoticed — but `docs/subagents.md` has one and
 *  `docs/plugin-root.md` links to it correctly, so the moment this slugger is pointed at doc→doc
 *  links (below) the bug turns a VALID link into a reported break. Getting a guard's own oracle
 *  wrong is worse than having no guard: it trains you to distrust the failure. */
function githubSlug(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9 _-]/g, "")
    .replace(/\s/g, "-");
}

/** Extract ATX headings (# ... ######) from markdown, skipping anything inside fenced code
 *  blocks (``` or ~~~) — README.md has shell comments like "# 0. Before the first live run"
 *  inside bash fences that are NOT real headings. */
function extractHeadings(text: string): string[] {
  const headings: string[] = [];
  let inFence = false;
  for (const line of text.split("\n")) {
    if (/^(```|~~~)/.test(line.trim())) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = line.match(/^#{1,6}\s+(.*)$/);
    if (m) headings.push(m[1].trim());
  }
  return headings;
}

function readmeSlugSet(): Set<string> {
  const text = readFileSync(README_PATH, "utf8");
  return new Set(extractHeadings(text).map(githubSlug));
}

function repoDocFiles(): string[] {
  const docsDir = resolve("docs");
  const docs = readdirSync(docsDir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => join(docsDir, f));
  const examplesReadme = resolve("examples/README.md");
  return [...docs, examplesReadme];
}

interface AnchorRef {
  file: string;
  slug: string;
  raw: string;
}

function readmeAnchorRefs(file: string): AnchorRef[] {
  const text = readFileSync(file, "utf8");
  const refs: AnchorRef[] = [];
  // Matches ](../README.md#slug), ](./README.md#slug), ](README.md#slug)
  const re = /\]\((?:\.\.?\/)?README\.md#([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    refs.push({ file, slug: m[1], raw: m[0] });
  }
  return refs;
}

describe("repo docs' ../README.md anchors resolve to real README headings (C1b)", () => {
  const slugs = readmeSlugSet();

  it("parsed a sane README heading set (guards against extraction silently breaking)", () => {
    expect(slugs.size).toBeGreaterThan(5);
    // Canary against the extractor silently returning nothing. Must name a heading the README still
    // OWNS: `commands-at-a-glance` was the old canary and moved to docs/cli.md in the router split, so
    // it would now assert the extractor is broken when it is working correctly. `fidelity-tiers…` is a
    // deliberate choice — the plan pins its heading text as verbatim-unchanged precisely because other
    // pages deep-link it, which is what makes it a stable canary.
    expect(slugs.has("fidelity-tiers-pick-per-scenario--per-ci-job")).toBe(true);
  });

  const files = repoDocFiles();
  expect(files.length).toBeGreaterThan(1);

  const allRefs = files.flatMap((f) => readmeAnchorRefs(f));

  it("found at least one ../README.md anchor reference to check (guards against a no-op test)", () => {
    expect(allRefs.length).toBeGreaterThan(0);
  });

  it("every ](../README.md#slug) anchor in docs/*.md and examples/README.md matches a real README heading", () => {
    const broken = allRefs.filter((r) => !slugs.has(r.slug));
    expect(
      broken,
      broken.map((r) => `${r.file.replace(resolve(".") + "/", "")}: ${r.raw} — #${r.slug} has no matching README heading`).join("\n"),
    ).toEqual([]);
  });
});

// Same integrity check, one hop further: a doc linking into ANOTHER DOC's heading. The suite above
// covers only links into root README.md, so `](./other-doc.md#slug)` was unguarded — a deliberately
// broken anchor was verified to pass it. That is the more common shape in this repo (21 such links
// today), and the failure is silent for exactly the same reason: the FILE resolves, so nothing
// notices the fragment points at nothing.
//
// This is preventive, not remedial: after fixing the slugger's underscore handling above, all 21
// currently resolve. The one apparent break before that fix was the slugger's own bug, not a bad link.
function docAnchorRefs(file: string): (AnchorRef & { target: string })[] {
  const text = readFileSync(file, "utf8");
  const refs: (AnchorRef & { target: string })[] = [];
  // ](./name.md#slug) / ](name.md#slug) — same-directory doc links. Deliberately excludes
  // `../README.md` (the suite above owns it) and any absolute/remote URL.
  const re = /\]\((?:\.\/)?([a-zA-Z0-9._-]+\.md)#([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1] === "README.md") continue; // root-README links belong to the suite above
    refs.push({ file, slug: m[2], raw: m[0], target: join(resolve("docs"), m[1]) });
  }
  return refs;
}

describe("docs' sibling-doc anchors resolve to real headings in the target doc", () => {
  const refs = repoDocFiles().flatMap(docAnchorRefs);

  it("found sibling-doc anchor references to check (guards against a no-op test)", () => {
    expect(refs.length).toBeGreaterThan(5);
  });

  it("the slugger keeps underscores (the bug that made a valid link look broken)", () => {
    // Pins the fix above against regression, using the real heading that exposed it.
    expect(githubSlug("Static `subagent_type` resolution (`resolve-agent-types` / `lint-skill`)")).toBe(
      "static-subagent_type-resolution-resolve-agent-types--lint-skill",
    );
  });

  it("every ](./sibling.md#slug) anchor matches a real heading in that doc", () => {
    const slugCache = new Map<string, Set<string>>();
    const slugsFor = (target: string): Set<string> | null => {
      if (!slugCache.has(target)) {
        if (!existsSync(target)) return null;
        slugCache.set(target, new Set(extractHeadings(readFileSync(target, "utf8")).map(githubSlug)));
      }
      return slugCache.get(target) ?? null;
    };
    const broken = refs.filter((r) => {
      const s = slugsFor(r.target);
      return s === null || !s.has(r.slug);
    });
    expect(
      broken,
      broken.map((r) => `${r.file.replace(resolve(".") + "/", "")}: ${r.raw} — #${r.slug} has no matching heading`).join("\n"),
    ).toEqual([]);
  });
});
