import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

// The shipped skill payload (.claude/skills/cowork-harness/**) points at ~a dozen `docs/*.md` files that
// do NOT sit beside it. That is fine — and deliberate — because SKILL.md DEFINES the term "repo-only"
// and tells the reader where those docs actually live in an npm install. Three things have to hold for
// that to keep working, and none was guarded:
//
//   1. the definition survives — it is load-bearing for every "repo-only" pointer in the payload, and a
//      reader who meets `(repo-only)` without it concludes the doc is unavailable when it is one path away;
//   2. every referenced doc exists — a rename leaves a dead pointer that no link checker would catch;
//   3. every referenced doc is actually SHIPPED by package.json's `files` — a doc can exist in the repo
//      and still be excluded from the tarball by a `files` negation, which dangles for npm consumers too.
const ROOT = resolve(__dirname, "..");
const SKILL = ".claude/skills/cowork-harness/SKILL.md";
const REFS_DIR = ".claude/skills/cowork-harness/references";

const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");

/** Every shipped payload file that could carry a pointer. */
function payloadFiles(): string[] {
  const refs = readdirSync(join(ROOT, REFS_DIR))
    .filter((f) => f.endsWith(".md"))
    .map((f) => `${REFS_DIR}/${f}`);
  return [SKILL, ...refs];
}

/** `docs/<name>.md` targets referenced from a file, ignoring absolute GitHub URLs (already resolvable). */
function docPointers(text: string): string[] {
  const withoutUrls = text.replace(/https?:\/\/\S+/g, "");
  return [...new Set([...withoutUrls.matchAll(/\bdocs\/[a-z0-9/-]+\.md/g)].map((m) => m[0]))];
}

/** `docs/`-scoped negations from package.json `files` (the `!`-prefixed entries). */
function shippedDocExclusions(): string[] {
  const pkg = JSON.parse(read("package.json")) as { files?: string[] };
  return (pkg.files ?? []).filter((f) => f.startsWith("!") && f.slice(1).startsWith("docs/")).map((f) => f.slice(1));
}

describe("shipped skill payload — docs/ pointers stay resolvable", () => {
  it("SKILL.md still DEFINES 'repo-only' and names the npm path (the note the pointers depend on)", () => {
    const skill = read(SKILL);
    // Content-anchored, not line-anchored: the note may move, but it must keep saying these three things.
    expect(skill).toMatch(/"repo-only" in this skill means/);
    expect(skill).toMatch(/node_modules\/cowork-harness\/docs\//);
    expect(skill).toMatch(/\bplugin\b[\s\S]{0,120}dangle/);
  });

  it("the note precedes the first `repo-only` USE (a definition after the fact does not help a reader)", () => {
    const skill = read(SKILL);
    const defAt = skill.search(/"repo-only" in this skill means/);
    const firstUse = skill.search(/repo-only/);
    expect(defAt).toBeGreaterThan(-1);
    // The first match of /repo-only/ is allowed to BE the definition's own heading; require that no
    // parenthetical use appears before it.
    const firstParenUse = skill.search(/\(repo-only/);
    if (firstParenUse > -1) expect(defAt).toBeLessThan(firstParenUse);
    expect(firstUse).toBeGreaterThan(-1);
  });

  it("every docs/*.md referenced from the payload EXISTS", () => {
    const missing: string[] = [];
    for (const f of payloadFiles()) for (const d of docPointers(read(f))) if (!existsSync(join(ROOT, d))) missing.push(`${f} -> ${d}`);
    expect(missing).toEqual([]);
  });

  it("every docs/*.md referenced from the payload is SHIPPED (not excluded by package.json files)", () => {
    const excluded = shippedDocExclusions();
    const unshipped: string[] = [];
    for (const f of payloadFiles())
      for (const d of docPointers(read(f)))
        if (excluded.some((ex) => d === ex || d.startsWith(ex.endsWith("/") ? ex : `${ex}/`)))
          unshipped.push(`${f} -> ${d} (excluded by "!${d.split("/").slice(0, 2).join("/")}")`);
    expect(unshipped).toEqual([]);
  });

  it("MUTATION: a pointer at a non-existent doc is caught", () => {
    const fake = docPointers("see `docs/does-not-exist.md` for detail");
    expect(fake).toEqual(["docs/does-not-exist.md"]);
    expect(existsSync(join(ROOT, fake[0]))).toBe(false);
  });

  it("MUTATION: a pointer into an EXCLUDED docs subtree is caught", () => {
    const excluded = shippedDocExclusions();
    expect(excluded.length).toBeGreaterThan(0); // at least one docs/ subtree is excluded today
    const target = `${excluded[0]}/some-plan.md`;
    const hit = excluded.some((ex) => target.startsWith(`${ex}/`));
    expect(hit).toBe(true);
  });

  it("MUTATION: absolute GitHub URLs are not treated as repo-relative pointers", () => {
    expect(docPointers("see https://github.com/o/r/blob/main/docs/scenario.md for detail")).toEqual([]);
  });
});
