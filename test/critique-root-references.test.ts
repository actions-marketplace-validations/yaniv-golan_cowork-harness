import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { resolveRootReferences } from "../src/critique/resolve-references.js";
import { resolveCritiquedSkillDir } from "../src/critique/command.js";
import { packageEvidence, ROOT_REFERENCE_SECTION_PREFIX } from "../src/critique/package-evidence.js";
import { snapshotTurnBoundary } from "../src/critique/evidence.js";
import { buildPass1Prompt, buildPass2Prompt } from "../src/critique/evaluator.js";
import { armorEvidence } from "../src/critique/armor.js";

// A multi-skill plugin's SHARED plugin-root `references/` is mounted for the graded turn but was rooted at
// `skillDir`, so a root file the skill's own SKILL.md points at was invisible to the evaluator. Only files
// the skill points at are packaged — the whole tree was measured and rejected — and everything left out is
// REPORTED, which is what makes a narrow rule safe rather than silently lossy.

function tree(files: Record<string, string>, opts: { git?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "cwh-rootrefs-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  if (opts.git) {
    // `corpusAcceptFor` returns null — ACCEPT EVERYTHING — for a non-work-tree or an empty tracked set, so
    // a tracked-file assertion in a plain tmpdir is a test that cannot fail.
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "-A"], { cwd: root });
  }
  return root;
}
const resolveFor = (root: string, skill: string, accesses?: Array<{ path: string; via: string[] }>) => {
  const r = resolveCritiquedSkillDir(root, skill);
  return resolveRootReferences({ pluginRoot: root, skillDir: r.skillDir, agents: r.agents, accesses });
};

describe("resolveRootReferences — selection", () => {
  it("packages a root reference the SKILL.md links by <plugin>/ prefix", () => {
    const root = tree({
      "plugin.json": '{"name": "plug"}',
      "skills/ms/SKILL.md": "# ms\nSee `plug/references/shared.md` for the model.\n",
      "references/shared.md": "SHARED-BODY\n",
    });
    const r = resolveFor(root, "ms");
    expect(r.packaged.map((p) => p.displayKey)).toEqual(["plug/references/shared.md"]);
    expect(r.packaged[0]!.via).toBe("SKILL.md:2");
    expect(r.packaged[0]!.rel).toBe("references/shared.md"); // the ACCEPT key, distinct from the display key
  });

  it("packages the ARMED form: a directory token plus bare backticked filenames", () => {
    // The dominant real form. A prefix-matching rule missed 8 of 9 links on the real tree because the only
    // token carrying a separator here is the DIRECTORY.
    const root = tree({
      "plugin.json": '{"name": "plug"}',
      "skills/ms/SKILL.md": "# ms\nFrom `${CLAUDE_PLUGIN_ROOT}/references/` (shared): `a.md`, `b.md`\n",
      "references/a.md": "A\n",
      "references/b.md": "B\n",
      "references/c.md": "C\n",
    });
    const r = resolveFor(root, "ms");
    expect(r.packaged.map((p) => p.displayKey)).toEqual(["plug/references/a.md", "plug/references/b.md"]);
    expect(r.omitted).toEqual([{ name: "plug/references/c.md", reason: "not-linked" }]);
  });

  it("arming does NOT carry to the next line", () => {
    const root = tree({
      "plugin.json": '{"name": "plug"}',
      "skills/ms/SKILL.md": "# ms\nFrom `${CLAUDE_PLUGIN_ROOT}/references/`: `a.md`\nLocal files: `b.md`\n",
      "references/a.md": "A\n",
      "references/b.md": "B\n",
    });
    expect(resolveFor(root, "ms").packaged.map((p) => p.displayKey)).toEqual(["plug/references/a.md"]);
  });

  it("a directory token ALONE packages nothing (it must never recurse into wholesale)", () => {
    const root = tree({
      "plugin.json": '{"name": "plug"}',
      "skills/ms/SKILL.md": "# ms\nSee `${CLAUDE_PLUGIN_ROOT}/references/` for shared material.\n",
      "references/a.md": "A\n",
      "references/b.md": "B\n",
    });
    expect(resolveFor(root, "ms").packaged).toEqual([]);
  });

  it("a BARE references/x.md means the skill's OWN file, not the root's", () => {
    const root = tree({
      "plugin.json": '{"name": "plug"}',
      "skills/ms/SKILL.md": "# ms\nSee `references/dup.md`.\n",
      "skills/ms/references/dup.md": "LOCAL\n",
      "references/dup.md": "ROOT\n",
    });
    const r = resolveFor(root, "ms");
    expect(r.packaged).toEqual([]);
    expect(r.omitted).toEqual([{ name: "plug/references/dup.md", reason: "not-linked" }]);
  });

  it("a link only in the skill's OWN references/** counts (SKILL.md never mentions it)", () => {
    const root = tree({
      "plugin.json": '{"name": "plug"}',
      "skills/ms/SKILL.md": "# ms\nNothing here.\n",
      "skills/ms/references/deep.md": "See `plug/references/shared.md`.\n",
      "references/shared.md": "SHARED\n",
    });
    const r = resolveFor(root, "ms");
    expect(r.packaged.map((p) => p.displayKey)).toEqual(["plug/references/shared.md"]);
    expect(r.packaged[0]!.via).toBe("references/deep.md:1");
  });

  it("a link from a packaged AGENT body counts, incl. frontmatter and an unbalanced trailing paren", () => {
    const root = tree({
      "plugin.json": '{"name": "plug"}',
      "skills/ms/SKILL.md": "# ms\n",
      "agents/ms.md": "---\nname: ms\ndescription: (see plug/references/shared.md): does things\n---\nbody\n",
      "references/shared.md": "SHARED\n",
    });
    const r = resolveFor(root, "ms");
    expect(r.packaged.map((p) => p.displayKey)).toEqual(["plug/references/shared.md"]);
    expect(r.packaged[0]!.via).toBe("agent:ms:3");
  });

  it("no plugin manifest: the display key falls back to the root's basename", () => {
    const root = tree({
      "skills/ms/SKILL.md": "# ms\nSee `../../references/shared.md`.\n",
      "references/shared.md": "SHARED\n",
    });
    const r = resolveFor(root, "ms");
    expect(r.packaged).toHaveLength(1);
    expect(r.packaged[0]!.displayKey.endsWith("/references/shared.md")).toBe(true);
  });
});

describe("resolveRootReferences — clause 3 (read during the run) three-way mapping", () => {
  const base = {
    "plugin.json": '{"name": "plug"}',
    "skills/ms/SKILL.md": "# ms\n",
    "skills/ms/references/dup.md": "LOCAL\n",
    "references/dup.md": "ROOT\n",
    "references/rootonly.md": "ROOTONLY\n",
  };
  it("root-only → packaged", () => {
    const r = resolveFor(tree(base), "ms", [{ path: "references/rootonly.md", via: ["read"] }]);
    expect(r.packaged.map((p) => p.displayKey)).toEqual(["plug/references/rootonly.md"]);
    expect(r.packaged[0]!.via).toBe("read-by-agent");
  });
  it("present in BOTH trees → not packaged, recorded ambiguous (the access key cannot tell them apart)", () => {
    const r = resolveFor(tree(base), "ms", [{ path: "references/dup.md", via: ["read"] }]);
    expect(r.packaged).toEqual([]);
    expect(r.omitted).toContainEqual({ name: "plug/references/dup.md", reason: "ambiguous-read" });
  });
  it("a path in neither tree is ignored (a sibling skill's reference — the whole plugin is mounted)", () => {
    const r = resolveFor(tree(base), "ms", [{ path: "references/elsewhere.md", via: ["read"] }]);
    expect(r.packaged).toEqual([]);
  });
  it("a bash/grep-only access does not count; unobservable access contributes nothing", () => {
    expect(resolveFor(tree(base), "ms", [{ path: "references/rootonly.md", via: ["bash"] }]).packaged).toEqual([]);
    expect(resolveFor(tree(base), "ms", undefined).packaged).toEqual([]);
  });
});

describe("resolveRootReferences — filters and skips", () => {
  it("a LINKED binary is omitted as not-utf8; an UNLINKED one is not-linked (link-first precedence)", () => {
    const root = tree({
      "plugin.json": '{"name": "plug"}',
      "skills/ms/SKILL.md": "# ms\nSee `plug/references/font.bin`.\n",
      "references/font.bin": "",
      "references/other.bin": "",
    });
    writeFileSync(join(root, "references/font.bin"), Buffer.from([0x00, 0xff, 0xfe, 0x41]));
    writeFileSync(join(root, "references/other.bin"), Buffer.from([0x00, 0xff, 0xfe, 0x42]));
    const r = resolveFor(root, "ms");
    expect(r.packaged).toEqual([]);
    expect(r.omitted).toContainEqual({ name: "plug/references/font.bin", reason: "not-utf8" });
    expect(r.omitted).toContainEqual({ name: "plug/references/other.bin", reason: "not-linked" });
  });

  it("SKIPS entirely when the plugin root IS the skill dir (else one file is both packaged and not-linked)", () => {
    const root = tree({ "plugin.json": '{"name": "solo"}', "SKILL.md": "# solo\n", "references/a.md": "A\n" });
    expect(resolveRootReferences({ pluginRoot: root, skillDir: root, agents: [] })).toEqual({ packaged: [], omitted: [] });
  });
});

describe("packageEvidence — rendering, keys and the tracked-set filter", () => {
  function pkg(root: string, skill: string, observable = false) {
    const r = resolveCritiquedSkillDir(root, skill);
    const outDir = mkdtempSync(join(tmpdir(), "cwh-out-"));
    if (observable) {
      // `noSkillFilesRead` is `undefined` whenever the run recorded no observable tool stream, which is
      // the state of a bare stub dir — so asserting the signal REQUIRES staging a turn-1 result, or the
      // assertion passes for a reason unrelated to what it claims to test.
      const turnDir = join(outDir, "turns", "1");
      mkdirSync(turnDir, { recursive: true });
      writeFileSync(join(turnDir, "result.json"), JSON.stringify({ finalMessage: "ok", referencesRead: [], referencesAccessed: [] }));
    }
    return packageEvidence(outDir, snapshotTurnBoundary(outDir), r.skillDir, true, { agents: r.agents, pluginRoot: r.pluginRoot });
  }

  it("renders the body in a section and keys it by the DISPLAY key", () => {
    const root = tree({
      "plugin.json": '{"name": "plug"}',
      "skills/ms/SKILL.md": "# ms\nSee `plug/references/shared.md`.\n",
      "references/shared.md": "SHARED-ROOT-BODY\n",
    });
    const res = pkg(root, "ms");
    // Assert the RENDERED text, not corpusPackaged alone — a key/title mismatch leaves the key present
    // while the section is never emitted.
    const rendered = res.sections.map((s) => `## ${s.title}\n${s.body}`).join("\n");
    expect(rendered).toContain("SHARED-ROOT-BODY");
    expect(rendered).toContain(ROOT_REFERENCE_SECTION_PREFIX);
    expect(rendered).toContain("in corpus via SKILL.md:2");
    expect(res.corpusPackaged).toContain("plug/references/shared.md");
    expect(res.corpusOmitted).toEqual([]);
  });

  it("an UNTRACKED root reference goes to corpusExcluded under the display key, not the accept key", () => {
    const root = tree(
      {
        "plugin.json": '{"name": "plug"}',
        "skills/ms/SKILL.md": "# ms\nSee `plug/references/shared.md`.\n",
        "references/tracked.md": "T\n",
      },
      { git: true },
    );
    // written AFTER `git add`, so it is linked and clean but staging would not deliver it
    writeFileSync(join(root, "references/shared.md"), "UNTRACKED\n");
    const res = pkg(root, "ms");
    expect(res.corpusExcluded).toContain("plug/references/shared.md");
    expect(res.corpusExcluded).not.toContain("references/shared.md");
    expect(res.corpusPackaged).not.toContain("plug/references/shared.md");
  });

  it("a TRACKED root reference is packaged (git-backed, so the accept filter is really exercised)", () => {
    const root = tree(
      {
        "plugin.json": '{"name": "plug"}',
        "skills/ms/SKILL.md": "# ms\nSee `plug/references/shared.md`.\n",
        "references/shared.md": "TRACKED-BODY\n",
      },
      { git: true },
    );
    const res = pkg(root, "ms");
    expect(res.corpusPackaged).toContain("plug/references/shared.md");
    expect(res.corpusExcluded).not.toContain("plug/references/shared.md");
  });

  it("noSkillFilesRead accounts for root references when the skill has none of its own", () => {
    const root = tree({
      "plugin.json": '{"name": "plug"}',
      "skills/ms/SKILL.md": "# ms\nSee `plug/references/shared.md`.\n",
      "references/shared.md": "S\n",
    });
    // No local references/ and no scripts/, so the suppression branch used to force `undefined`
    // ("nothing to read") over a corpus that now has a shared file in it. ASSERT THE SIGNAL, not just
    // that the file was packaged — a test named for `noSkillFilesRead` that only checks `corpusPackaged`
    // passes with the fix reverted.
    const res = pkg(root, "ms", true);
    expect(res.corpusPackaged).toContain("plug/references/shared.md");
    // The run observed the tool stream and saw no reference access, and there WAS material to read —
    // so the signal must fire rather than being suppressed as "nothing to read".
    expect(res.noSkillFilesRead).toBe(true);
  });

  it("populates corpusOmitted through the packager, not only the resolver", () => {
    const root = tree({
      "plugin.json": '{"name": "plug"}',
      "skills/ms/SKILL.md": "# ms\nSee `plug/references/linked.md`.\n",
      "references/linked.md": "L\n",
      "references/orphan.md": "O\n",
    });
    const res = pkg(root, "ms");
    expect(res.corpusPackaged).toContain("plug/references/linked.md");
    // The threading resolver -> PackageEvidenceResult was only ever asserted EMPTY; a populated list is
    // what a reader actually sees, and what the narrow selection rule depends on being truthful.
    expect(res.corpusOmitted).toEqual([{ name: "plug/references/orphan.md", reason: "not-linked" }]);
  });
});

describe("the evaluator prompt and the packager share ONE title constant", () => {
  // A string-presence check would pass while the packager emitted a different title. Both sides must read
  // the same exported constant, so assert the constant's VALUE appears in both prompts.
  const ev = armorEvidence([{ title: "SKILL.md", body: "x" }]);
  it("pass 1 names the plugin-root section", () => {
    expect(buildPass1Prompt(ev)).toContain(ROOT_REFERENCE_SECTION_PREFIX);
  });
  it("pass 2 names the plugin-root section", () => {
    expect(buildPass2Prompt(ev, [], "self report", false, false)).toContain(ROOT_REFERENCE_SECTION_PREFIX);
  });
  it("neither prompt leaks uninterpolated template syntax", () => {
    expect(buildPass1Prompt(ev)).not.toContain("${ROOT_REFERENCE_SECTION_PREFIX}");
    expect(buildPass2Prompt(ev, [], "self report", false, false)).not.toContain("${ROOT_REFERENCE_SECTION_PREFIX}");
  });
});

describe("trimPriority ranks a plugin-root section with the corpus, not with the run-variant sections", () => {
  it("shaves the plugin-root section BEFORE the transcript and alongside references/", async () => {
    const { trimToPackageCap } = await import("../src/critique/package-evidence.js");
    // Unmatched titles fall to priority 1 — shaved after references/ but interleaved with the structured
    // JSON sections, against the documented corpus-first intent. This asserts the new prefix is matched.
    const big = "x".repeat(60_000);
    const sections = [
      { title: "SKILL.md (…)", body: big },
      { title: `${ROOT_REFERENCE_SECTION_PREFIX} (plug/references/shared.md …)`, body: big },
      { title: "Transcript (turn 1 only …)", body: big },
    ];
    const { trimRecord } = trimToPackageCap(sections, 100_000);
    // `trimToPackageCap` mutates `sections` and records what it shaved, in order.
    expect(trimRecord.length).toBeGreaterThan(0);
    expect(trimRecord[0]!.section).toContain(ROOT_REFERENCE_SECTION_PREFIX);
    expect(trimRecord[0]!.section).not.toContain("Transcript");
  });
});

describe("the text report RENDERS the omissions — the 'loud remainder' the design rests on", () => {
  it("prints a plugin-root line per reason, distinct from the untracked corpusExcluded line", async () => {
    const { buildTextReport } = await import("../src/critique/command.js");
    const text = buildTextReport({
      skillFolder: "/p",
      prompt: "p",
      sessionId: "s",
      outDir: "/o",
      fidelity: "container",
      items: [],
      evidenceBudget: {
        corpusBytes: 10,
        corpusCeiling: 524_288,
        corpusCuts: [],
        corpusExcluded: ["plug/references/untracked.md"],
        corpusPackaged: ["SKILL.md"],
        corpusOmitted: [
          { name: "plug/references/other.md", reason: "not-linked" },
          { name: "plug/references/font.woff2", reason: "not-utf8" },
        ],
        trimRecord: [],
        packageTruncated: false,
      },
    } as never);
    expect(text).toContain("plug/references/other.md");
    expect(text).toContain("plug/references/font.woff2");
    expect(text).toContain("never point at them"); // the not-linked explanation
    expect(text).toContain("not valid UTF-8"); // the not-utf8 explanation
    // and the untracked file keeps its own, different remedy — the two must never be merged
    expect(text).toContain("'git add' them");
  });
});

describe("resolveRootReferences — shared cross-language fixture", () => {
  // Executed by BOTH this file and python/test_scenario_lint.py against hand-written expectations. The
  // packager and the linter agreeing on the real tree today is not a pin; this is. Clauses 1-2 only —
  // clause 3 is run-dependent and a static linter has no run to mirror.
  interface Case {
    name: string;
    skill: string;
    tree: Record<string, string>;
    expected: string[];
  }
  const fixture = JSON.parse(readFileSync(resolve("test/fixtures/root-references.json"), "utf8")) as { cases: Case[] };

  for (const c of fixture.cases) {
    it(c.name, () => {
      const root = tree(c.tree);
      const r = resolveCritiquedSkillDir(root, c.skill);
      const got = resolveRootReferences({ pluginRoot: root, skillDir: r.skillDir, agents: r.agents }).packaged.map((p) => p.rel);
      expect(got.sort()).toEqual([...c.expected].sort());
    });
  }

  it("the fixture is non-trivial (a fixture that lost its cases must not read as a clean pass)", () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(10);
  });
});
