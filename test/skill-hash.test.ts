import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashSkillDirs, skillHashEntries, OS_JUNK_PATTERN, compileIgnore, agentSkillName } from "../src/run/skill-hash.js";
import { createHash } from "node:crypto";

function skillDir(): string {
  const d = mkdtempSync(join(tmpdir(), "skill-"));
  mkdirSync(join(d, "skills"), { recursive: true });
  writeFileSync(join(d, "skills", "SKILL.md"), "# real skill content\n");
  return d;
}

describe("skill-hash — v8 framing closes the unframed-concatenation collision", () => {
  // Pre-v8, skillHash folded RAW content after `F:<relPath>\0`, so a two-file tree {p:"A", q:"B"}
  // folded the identical byte stream as a single file p whose content embeds the q boundary
  // (`A` + `F:skills/q\0` + `B`) — a staleness FALSE-NEGATIVE. v8 folds the fixed-length content SHA
  // instead (self-delimiting; sha charset is disjoint from the `F:`/`L:` prefixes), so they differ.
  // This test FAILS on the old algorithm (identical hashes) and passes on v8.
  it("a file whose content embeds a fake entry boundary does NOT collide with a two-file tree", () => {
    const twoFiles = mkdtempSync(join(tmpdir(), "skill-collA-"));
    mkdirSync(join(twoFiles, "skills"), { recursive: true });
    writeFileSync(join(twoFiles, "skills", "p"), "A");
    writeFileSync(join(twoFiles, "skills", "q"), "B");

    const oneFile = mkdtempSync(join(tmpdir(), "skill-collB-"));
    mkdirSync(join(oneFile, "skills"), { recursive: true });
    writeFileSync(join(oneFile, "skills", "p"), "A" + "F:skills/q\0" + "B"); // embeds the old boundary marker

    expect(hashSkillDirs([twoFiles]).hash).not.toBe(hashSkillDirs([oneFile]).hash);
  });
});

describe("skill-hash — excludes cassettes/VCS, keeps real source", () => {
  it("is unchanged when a recorded cassette is written into an existing cassettes dir (self-invalidation fix)", () => {
    const d = skillDir();
    // The real scenario: the cassettes dir already exists in the tree; recording writes a *.cassette.json
    // into it. The file is excluded by extension, so the fingerprint it just recorded does not change.
    mkdirSync(join(d, "tests", "cowork", "cassettes"), { recursive: true });
    const before = hashSkillDirs([d]).hash;
    writeFileSync(join(d, "tests", "cowork", "cassettes", "a.cassette.json"), "{}");
    expect(hashSkillDirs([d]).hash).toBe(before); // a cassette is output, not skill source
    writeFileSync(join(d, "tests", "cowork", "cassettes", "b.cassette.json"), '{"x":1}');
    expect(hashSkillDirs([d]).hash).toBe(before); // and a second one
  });

  it("is unchanged when a VCS/cache dir changes", () => {
    const d = skillDir();
    const before = hashSkillDirs([d]).hash;
    mkdirSync(join(d, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(d, "node_modules", "pkg", "index.js"), "x");
    mkdirSync(join(d, ".git"), { recursive: true });
    writeFileSync(join(d, ".git", "HEAD"), "ref: x");
    expect(hashSkillDirs([d]).hash).toBe(before);
  });

  it("STILL changes when real skill source changes (no false negative)", () => {
    const d = skillDir();
    const before = hashSkillDirs([d]).hash;
    writeFileSync(join(d, "skills", "SKILL.md"), "# v2 — behavior changed\n");
    expect(hashSkillDirs([d]).hash).not.toBe(before);
  });

  it("STILL changes when a non-cassette file under tests/ changes (tests/ is NOT excluded by name)", () => {
    const d = skillDir();
    mkdirSync(join(d, "tests"), { recursive: true });
    writeFileSync(join(d, "tests", "helper.py"), "x = 1\n");
    const before = hashSkillDirs([d]).hash;
    writeFileSync(join(d, "tests", "helper.py"), "x = 2\n");
    expect(hashSkillDirs([d]).hash).not.toBe(before); // conservative: a code edit under tests/ still counts
  });
});

describe("skillHashEntries diagnostics (dump what the hash sees)", () => {
  it("lists exactly the files the hash folds in, with a content sha that matches per-file", () => {
    const d = skillDir();
    writeFileSync(join(d, "skills", "extra.md"), "more\n");
    const entries = skillHashEntries([d]);
    const paths = entries.map((e) => e.path);
    expect(paths).toEqual(["skills/SKILL.md", "skills/extra.md"]); // sorted, scoped to the hashed set
    // the reported sha is the sha256 of the file content the hash used (raw bytes here)
    const sha = createHash("sha256").update("# real skill content\n").digest("hex");
    expect(entries.find((e) => e.path === "skills/SKILL.md")!.sha).toBe(sha);
  });

  it("excludes the same files the hash excludes (cassettes, VCS dirs, hashignore file)", () => {
    const d = skillDir();
    mkdirSync(join(d, ".git"), { recursive: true });
    writeFileSync(join(d, ".git", "HEAD"), "ref: x");
    writeFileSync(join(d, "a.cassette.json"), "{}");
    writeFileSync(join(d, ".cowork-hashignore"), "junk\n");
    const paths = skillHashEntries([d]).map((e) => e.path);
    expect(paths).toEqual(["skills/SKILL.md"]); // no .git, no cassette, no hashignore file
  });

  it("(v5) OS-junk is EXCLUDED from the hash, so an out-of-band touch can't re-stale", () => {
    const d = skillDir();
    const before = hashSkillDirs([d]).hash;
    // a .DS_Store appearing (or being rewritten by Finder) must NOT change the skill hash.
    writeFileSync(join(d, "skills", ".DS_Store"), "\x00\x01finder-state");
    expect(hashSkillDirs([d]).hash).toBe(before); // excluded → no drift
    writeFileSync(join(d, "skills", ".DS_Store"), "\x00\x02finder-moved-an-icon");
    expect(hashSkillDirs([d]).hash).toBe(before); // a subsequent rewrite still doesn't drift
    writeFileSync(join(d, "Thumbs.db"), "x");
    writeFileSync(join(d, "desktop.ini"), "x");
    expect(hashSkillDirs([d]).hash).toBe(before); // other OS-junk too
    // …and it's not in the hashed file set, while a real skill file is
    const paths = skillHashEntries([d]).map((e) => e.path);
    expect(paths).toEqual(["skills/SKILL.md"]);
    expect(OS_JUNK_PATTERN.test("skills/.DS_Store")).toBe(true);
    expect(OS_JUNK_PATTERN.test("skills/SKILL.md")).toBe(false); // a real skill file is NOT junk
  });

  it("STILL changes when a real source file changes (OS-junk exclusion didn't weaken detection)", () => {
    const d = skillDir();
    writeFileSync(join(d, "skills", ".DS_Store"), "junk");
    const before = hashSkillDirs([d]).hash;
    writeFileSync(join(d, "skills", "SKILL.md"), "# changed\n");
    expect(hashSkillDirs([d]).hash).not.toBe(before); // real change still detected
  });
});

describe("(v6) in-tree symlinks are hashed by target; escaping symlinks are skipped", () => {
  it("an in-tree symlink contributes (and a RE-POINT to a different in-tree file drifts the hash)", () => {
    const d = skillDir(); // skills/SKILL.md
    writeFileSync(join(d, "skills", "OTHER.md"), "# other\n");
    const baseline = hashSkillDirs([d]).hash;
    symlinkSync("SKILL.md", join(d, "skills", "link.md")); // in-tree relative symlink
    const withLink = hashSkillDirs([d]).hash;
    expect(withLink).not.toBe(baseline); // the symlink is hashed (by target), not silently skipped
    // re-point to a DIFFERENT in-tree file (same symlink name) → must drift even though no file content changed
    const d2 = skillDir();
    writeFileSync(join(d2, "skills", "OTHER.md"), "# other\n");
    symlinkSync("OTHER.md", join(d2, "skills", "link.md"));
    expect(hashSkillDirs([d2]).hash).not.toBe(withLink); // a re-point is detected
  });

  it("an ESCAPING symlink (target outside the tree) is skipped (not followed)", () => {
    const d = skillDir();
    const before = hashSkillDirs([d]).hash;
    symlinkSync("/etc/hosts", join(d, "skills", "escape.md")); // out-of-tree
    expect(hashSkillDirs([d]).hash).toBe(before); // escaping symlink excluded → no out-of-tree content
    expect(skillHashEntries([d]).some((e) => e.path.includes("escape.md"))).toBe(false);
  });
});

describe(".AppleDouble and __MACOSX directory subtrees are excluded", () => {
  it("a .AppleDouble directory added inside skills does not change the hash", () => {
    const d = skillDir();
    const before = hashSkillDirs([d]).hash;
    mkdirSync(join(d, "skills", ".AppleDouble"), { recursive: true });
    writeFileSync(join(d, "skills", ".AppleDouble", "SKILL.md"), "resource fork");
    expect(hashSkillDirs([d]).hash).toBe(before);
  });

  it("adding a file inside .AppleDouble after the dir exists still does not change the hash", () => {
    const d = skillDir();
    mkdirSync(join(d, "skills", ".AppleDouble"), { recursive: true });
    writeFileSync(join(d, "skills", ".AppleDouble", "x"), "a");
    const before = hashSkillDirs([d]).hash;
    writeFileSync(join(d, "skills", ".AppleDouble", "y"), "b");
    expect(hashSkillDirs([d]).hash).toBe(before);
  });

  it("a __MACOSX directory at the root does not change the hash", () => {
    const d = skillDir();
    const before = hashSkillDirs([d]).hash;
    mkdirSync(join(d, "__MACOSX"), { recursive: true });
    writeFileSync(join(d, "__MACOSX", "._skills"), "appledouble header");
    expect(hashSkillDirs([d]).hash).toBe(before);
  });

  it("real skill content still changes the hash (no false negative)", () => {
    const d = skillDir();
    mkdirSync(join(d, "skills", ".AppleDouble"), { recursive: true });
    writeFileSync(join(d, "skills", ".AppleDouble", "x"), "junk");
    const before = hashSkillDirs([d]).hash;
    writeFileSync(join(d, "skills", "SKILL.md"), "# changed\n");
    expect(hashSkillDirs([d]).hash).not.toBe(before);
  });
});

describe("compileIgnore handles /**/foo prefix", () => {
  it("/**/foo compiles to the same regex source as **/foo", () => {
    const a = compileIgnore("/**/foo");
    const b = compileIgnore("**/foo");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.source).toBe(b!.source);
  });

  it("/**/foo matches foo at any depth", () => {
    const re = compileIgnore("/**/foo")!;
    expect(re.test("foo")).toBe(true);
    expect(re.test("a/foo")).toBe(true);
    expect(re.test("a/b/foo")).toBe(true);
  });

  it("/**/foo does NOT match foobar", () => {
    const re = compileIgnore("/**/foo")!;
    expect(re.test("foobar")).toBe(false);
  });

  it("/**/foo/bar matches foo/bar and a/foo/bar", () => {
    const re = compileIgnore("/**/foo/bar")!;
    expect(re.test("foo/bar")).toBe(true);
    expect(re.test("a/foo/bar")).toBe(true);
    expect(re.test("foo/barbaz")).toBe(false);
  });

  it("/docs/api remains anchored to the root", () => {
    const re = compileIgnore("/docs/api")!;
    expect(re.test("docs/api")).toBe(true);
    expect(re.test("a/docs/api")).toBe(false);
  });
});

describe("agentSkillName respects isDirectory for dotted names", () => {
  it("a FILE agents/cap-table.v2 strips extension to cap-table.v2... wait, it strips only the last ext", () => {
    expect(agentSkillName(["agents", "cap-table.v2"], false)).toBe("cap-table");
  });

  it("a DIRECTORY agents/cap-table.v2 is used as-is (no extension strip)", () => {
    expect(agentSkillName(["agents", "cap-table.v2"], true)).toBe("cap-table.v2");
  });

  it("a FILE agents/cap-table.md strips extension to cap-table", () => {
    expect(agentSkillName(["agents", "cap-table.md"], false)).toBe("cap-table");
  });

  it("a multi-segment path agents/cap-table/x.md gives cap-table regardless of isDirectory", () => {
    expect(agentSkillName(["agents", "cap-table", "x.md"], false)).toBe("cap-table");
    expect(agentSkillName(["agents", "cap-table", "x.md"], true)).toBe("cap-table");
  });

  it("non-agents path returns null", () => {
    expect(agentSkillName(["skills", "cap-table"], false)).toBeNull();
  });
});

describe("NUL separator prevents newline-in-filename hash collisions", () => {
  it("two trees with different file counts hash differently (structural collision test)", () => {
    // Under \n separator, a file named "a\nF:b" with empty content and a tree with files "a" and "b"
    // (both empty) could collide: "F:a\nF:b\n" == "F:a\nF:b\n". Under \0 they are distinct.
    // We verify the simpler invariant: a single-file tree vs a two-file tree with same total content
    // must produce different hashes.
    const d1 = mkdtempSync(join(tmpdir(), "nul-sep-"));
    writeFileSync(join(d1, "a"), "hello");
    const d2 = mkdtempSync(join(tmpdir(), "nul-sep-"));
    writeFileSync(join(d2, "a"), "hello");
    writeFileSync(join(d2, "b"), "");
    expect(hashSkillDirs([d1]).hash).not.toBe(hashSkillDirs([d2]).hash);
  });
});

describe("multi-root identity — a KNOWN, PINNED limitation, not a fixed behaviour", () => {
  // These tests pin what the hash does TODAY so the eventual fix is a deliberate change rather than a
  // surprise. Read them as a specification of the limitation, not as an endorsement of it.
  //
  // `hashSkillDirs` does `const sorted = [...dirs].sort()` and folds each root's entries in that order.
  // Entries are ROOT-RELATIVE, so the concatenation order of roots is load-bearing while the roots' own
  // names are deliberately excluded from the digest. That is an internal inconsistency: a single root is
  // fully location-independent, but for two or more the excluded name re-enters through the sort.
  //
  // TWO SEPARATE AXES, and an earlier version of this comment got the second one WRONG:
  //   1. ORDER — reordering roots produces FALSE DRIFT: a loud, wrong "files changed". Loud and safe.
  //   2. CROSS-ROOT AGGREGATION — the roots fold into ONE digest with NO root-boundary marker, and entries
  //      are root-relative, so the hash is a function of the concatenated stream, not of the per-root
  //      partition. Moving a file BETWEEN roots is therefore INVISIBLE whenever the concatenation order
  //      survives. That IS a false green, and it is pinned below.
  // The earlier claim "never a false green" was false, and it was the stated justification for not
  // refusing multi-root cassettes. The decision stands on different ground: a cross-root move changes
  // which plugin root delivers a file, which is rare and deliberate, and no multi-root cassette exists in
  // any reachable corpus — so a warning at the point of use beats refusing input nobody has.
  //
  // Fixing it means folding a stable per-root identity into the digest, which changes the digest for every
  // multi-root cassette and therefore needs a hash-format epoch bump. Not scheduled: measured across every
  // reachable corpus (cowork-harness, founder-skills incl. cowork-tests, creative-problem-solving —
  // 32 cassettes on the widest denominator) there is not one multi-root cassette, and no session anywhere
  // declares 2+ plugin/skill roots.
  function rootWith(name: string, content: string): string {
    const d = mkdtempSync(join(tmpdir(), "mr-"));
    const r = join(d, name);
    mkdirSync(join(r, "skills"), { recursive: true });
    writeFileSync(join(r, "skills", "SKILL.md"), content);
    return r;
  }

  it("a SINGLE root is fully location-independent — the property everything else rests on", () => {
    // If this ever fails, `--session` and every relocation guarantee are void: the digest would depend on
    // where the tree happens to sit.
    const a = rootWith("aaa", "SAME");
    const b = rootWith("zzz", "SAME");
    expect(hashSkillDirs([a]).hash).toBe(hashSkillDirs([b]).hash);
  });

  it("argument order does NOT affect the digest — the internal sort normalises it", () => {
    // Stated explicitly because it is the test someone naturally reaches for and it proves NOTHING about
    // path order — the function sorts its arguments, so varying only the argument order is a no-op. It is
    // not literally unfailable (deleting the internal `sort()` reds it, so it is a weak regression guard on
    // the normalisation); it simply cannot speak to the limitation below. A previous version of this
    // comment claimed it "CANNOT FAIL", which mutation testing disproved.
    const a = rootWith("aaa", "A");
    const b = rootWith("bbb", "B");
    expect(hashSkillDirs([a, b]).hash).toBe(hashSkillDirs([b, a]).hash);
  });

  it("KNOWN LIMITATION: identical content at differently-sorting root names hashes differently", () => {
    // The discriminating test the one above is not. Same two trees; only which directory name each
    // occupies changes, so the sort folds them in the opposite order.
    const d1 = mkdtempSync(join(tmpdir(), "l1-"));
    const d2 = mkdtempSync(join(tmpdir(), "l2-"));
    const place = (base: string, name: string, content: string) => {
      const r = join(base, name);
      mkdirSync(join(r, "skills"), { recursive: true });
      writeFileSync(join(r, "skills", "SKILL.md"), content);
      return r;
    };
    const layout1 = [place(d1, "aaa", "ALPHA"), place(d1, "zzz", "BETA")];
    const layout2 = [place(d2, "aaa", "BETA"), place(d2, "zzz", "ALPHA")];
    expect(hashSkillDirs(layout1).hash).not.toBe(hashSkillDirs(layout2).hash);
  });

  it("KNOWN LIMITATION and a REAL FALSE GREEN: a file moved BETWEEN roots is invisible", () => {
    // The roots fold into one digest with no root-boundary marker, and entries are root-relative, so the
    // hash is a function of the concatenated stream rather than of the per-root partition. Same files,
    // different mount ownership, identical digest. This is what makes "never a false green" wrong.
    const build = (layout: Record<string, string[]>) => {
      const base = mkdtempSync(join(tmpdir(), "xr-"));
      return Object.entries(layout).map(([root, files]) => {
        const r = join(base, root);
        mkdirSync(r, { recursive: true });
        for (const f of files) writeFileSync(join(r, f), f.toUpperCase());
        return r;
      });
    };
    const l1 = build({ r1: ["a.md", "b.md"], r2: ["c.md"] });
    const l2 = build({ r1: ["a.md"], r2: ["b.md", "c.md"] });
    expect(hashSkillDirs(l1).hash, "b.md moved to another mount and the digest did not notice").toBe(hashSkillDirs(l2).hash);
  });

  it("KNOWN LIMITATION: duplicate root-relative paths make drift ATTRIBUTION ambiguous", () => {
    // Two mounts can emit the same relpath. The digest folds both entries, so drift is still DETECTED —
    // this is not a false green — but `diffFileSigsPaths` builds `new Map(recorded)`, which keeps only
    // the last, so the report can name the wrong file or none.
    const a = rootWith("ra", "FROM-A");
    const b = rootWith("rb", "FROM-B");
    const entries = skillHashEntries([a, b]);
    expect(entries.map((e) => e.path)).toEqual(["skills/SKILL.md", "skills/SKILL.md"]);
    expect(new Set(entries.map((e) => e.sha)).size, "same path, different content").toBe(2);
  });
});

describe("manifest version exemption — CHARACTERIZATION of today's asymmetry", () => {
  // `hashDir` strips `version` before hashing a manifest, but only for paths matching
  // `.claude-plugin/plugin.json` or a bare root `plugin.json` (skill-hash.ts:184). Any other manifest
  // location — `.cursor-plugin/plugin.json` is the live example — falls through to raw-byte hashing, so a
  // pure version bump there DOES re-stale every cassette that mounts it.
  //
  // This is a CHARACTERIZATION test: it pins what the code does today, not what it should do. The
  // asymmetry was completely uncovered — `grep -rl cursor-plugin test/` found nothing — so either half
  // could have been "fixed" or broken with nothing going red.
  //
  // If a future change makes the exemption path-agnostic (the canonicalisation work is the likely
  // occasion), THIS TEST FLIPS, and the flip is the evidence that the behaviour changed on purpose rather
  // than the asymmetry quietly reversing inside a large diff. Update it deliberately; do not delete it.
  function manifestRoot(dir: string): string {
    const d = mkdtempSync(join(tmpdir(), "mani-"));
    mkdirSync(join(d, dir), { recursive: true });
    writeFileSync(join(d, dir, "plugin.json"), '{"name":"p","version":"1"}');
    return d;
  }
  const bumped = (root: string, dir: string) => {
    writeFileSync(join(root, dir, "plugin.json"), '{"name":"p","version":"9.9.9"}');
    return hashSkillDirs([root]).hash;
  };

  it(".claude-plugin/plugin.json: a version bump is EXEMPT — the hash does not move", () => {
    const r = manifestRoot(".claude-plugin");
    const before = hashSkillDirs([r]).hash;
    expect(bumped(r, ".claude-plugin")).toBe(before);
  });

  it("a ROOT plugin.json is exempt too — the predicate covers both spellings", () => {
    const r = manifestRoot(".");
    const before = hashSkillDirs([r]).hash;
    expect(bumped(r, ".")).toBe(before);
  });

  it(".cursor-plugin/plugin.json: a version bump is NOT exempt — the hash DOES move", () => {
    // The asymmetry, stated as a fact about today rather than an endorsement of it.
    const r = manifestRoot(".cursor-plugin");
    const before = hashSkillDirs([r]).hash;
    expect(bumped(r, ".cursor-plugin")).not.toBe(before);
  });

  it("the exemption is version-ONLY, wherever it applies", () => {
    // Guards the other direction: a behaviour-bearing field must still re-stale, or the carve-out would be
    // silently hiding real drift rather than metadata churn.
    const r = manifestRoot(".claude-plugin");
    const before = hashSkillDirs([r]).hash;
    writeFileSync(join(r, ".claude-plugin", "plugin.json"), '{"name":"p","version":"1","mcpServers":{"x":{}}}');
    expect(hashSkillDirs([r]).hash).not.toBe(before);
  });
});
