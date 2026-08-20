import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { buildFingerprint, fingerprintSkillDrift, migrateFingerprint, CASSETTE_VERSION, requiredVersionFor } from "../src/run/cassette.js";
import { skillHashSnapshot, foldSnapshot, jcs1HashedContent, legacyHashedContent } from "../src/run/skill-hash.js";
import type { Fingerprint } from "../src/types.js";
import { loadBaseline } from "../src/baseline.js";

const CLI = resolve("dist/cli.js");
const EPOCH = requiredVersionFor({}); // the stamped floor, read from source rather than duplicated
// The RESOLVED baseline, not the alias: `rehash` compares the recorded appVersion against the live one and
// skips on drift, so a fixture recording "latest" never reaches the epoch logic at all.
const LIVE_BASELINE = loadBaseline("latest").appVersion;

/** A plugin root whose manifest key order is NOT canonical, so legacy and jcs1 digests differ. */
function unsortedRoot(): string {
  const d = mkdtempSync(join(tmpdir(), "epoch-"));
  mkdirSync(join(d, ".claude-plugin"), { recursive: true });
  mkdirSync(join(d, "skills", "s"), { recursive: true });
  writeFileSync(join(d, ".claude-plugin", "plugin.json"), '{"skills":"./skills","name":"p","version":"1"}');
  writeFileSync(join(d, "skills", "s", "SKILL.md"), "# s\n");
  return d;
}

describe("the epoch actually changes digests — and sometimes it does NOT", () => {
  it("an UNSORTED manifest hashes differently under the two algorithms", () => {
    const snap = skillHashSnapshot([unsortedRoot()]);
    expect(foldSnapshot(snap, "legacy")).not.toBe(foldSnapshot(snap, "jcs1"));
  });

  it("an ALREADY-CANONICAL manifest hashes IDENTICALLY — the reason we flag by version, not by outcome", () => {
    // This is the case that makes outcome-based flagging unsafe: the cassette would sail through
    // unlabelled, and at the NEXT epoch nobody could tell whether it was legacy or jcs1.
    const d = mkdtempSync(join(tmpdir(), "epoch-ok-"));
    mkdirSync(join(d, ".claude-plugin"), { recursive: true });
    mkdirSync(join(d, "skills", "s"), { recursive: true });
    writeFileSync(join(d, ".claude-plugin", "plugin.json"), '{"name":"p","skills":"./skills","version":"1"}');
    writeFileSync(join(d, "skills", "s", "SKILL.md"), "# s\n");
    const snap = skillHashSnapshot([d]);
    expect(foldSnapshot(snap, "legacy")).toBe(foldSnapshot(snap, "jcs1"));
  });

  it("a tree with NO manifest is untouched by the epoch", () => {
    const d = mkdtempSync(join(tmpdir(), "epoch-nom-"));
    mkdirSync(join(d, "skills", "s"), { recursive: true });
    writeFileSync(join(d, "skills", "s", "SKILL.md"), "# s\n");
    const snap = skillHashSnapshot([d]);
    expect(foldSnapshot(snap, "legacy")).toBe(foldSnapshot(snap, "jcs1"));
  });

  it("jcs1 is key-order insensitive where legacy was not", () => {
    const a = Buffer.from('{"name":"p","skills":"./s","version":"1"}');
    const b = Buffer.from('{"skills":"./s","name":"p","version":"1"}');
    expect(jcs1HashedContent(a, "claude-manifest")).toBe(jcs1HashedContent(b, "claude-manifest"));
    expect(legacyHashedContent(a, "claude-manifest")).not.toBe(legacyHashedContent(b, "claude-manifest"));
  });
});

describe("hashFormat is stamped on EVERY fingerprint return path", () => {
  // `buildFingerprint` returns early twice before the main object. A v12 fingerprint that omits
  // `hashFormat` violates the read-boundary invariant and would fail its own load — so a baseline-only or
  // read-error recording has to carry it exactly like a full one.
  it("including a ZERO-ROOT session, which returns before any hashing happens", () => {
    const d = mkdtempSync(join(tmpdir(), "epoch-zero-"));
    const sessionPath = join(d, "session.yaml");
    writeFileSync(sessionPath, "skills:\n  local: []\n");
    const fp = buildFingerprint(sessionPath, "1.0.0", d);
    expect(fp.skillHash).toBeUndefined(); // nothing to hash…
    expect(fp.hashFormat).toBe("jcs1"); // …but the format is still declared
  });

  it("and on a normal recording", () => {
    const d = unsortedRoot();
    const sessionPath = join(d, "session.yaml");
    writeFileSync(sessionPath, `skills:\n  local:\n    - ${d}\n`);
    expect(buildFingerprint(sessionPath, "1.0.0", d).hashFormat).toBe("jcs1");
  });
});

describe("verify-run — a kept RunResult has no version, so the format IS the discriminator", () => {
  const base: Fingerprint = { baseline: "1.0.0", skillHash: "aaa", hashFormat: "jcs1" };

  it("reports the FORMAT change, never 'the source changed'", () => {
    // Without this the epoch reads as source drift on every run kept before it — false, and with no hint
    // about what to do. There is no `cassetteVersion` here to route it anywhere else.
    const drift = fingerprintSkillDrift({ ...base, hashFormat: undefined }, { ...base, skillHash: "bbb" });
    expect(drift).toMatch(/hash format/);
    expect(drift).not.toMatch(/source changed/);
  });

  it("treats ABSENT as legacy, not as raw or as current", () => {
    expect(fingerprintSkillDrift({ ...base, hashFormat: undefined }, base)).toMatch(/hash format 'legacy'/);
  });

  it("reports an UNKNOWN format loudly rather than coercing it to either side", () => {
    const drift = fingerprintSkillDrift({ ...base, hashFormat: "jcs2" as "jcs1" }, base);
    expect(drift).toMatch(/unrecognized hash format 'jcs2'/);
  });

  it("still reports genuine source drift when the formats agree", () => {
    expect(fingerprintSkillDrift(base, { ...base, skillHash: "bbb" })).toMatch(/source changed/);
  });
});

describe("migrateFingerprint — selective, never a spread", () => {
  const recorded: Fingerprint = {
    baseline: "1.0.0",
    skillHash: "old",
    contentSig: "oldsig",
    promptAssetsHash: "491afe2862dc67ea",
    labelProvenance: [{ file: "SKILL.md", labels: ["A"] }],
    fileSigs: [["redacted/path.md", "oldsha"]],
    mode: "git",
  };
  const live: Fingerprint = {
    baseline: "1.0.0",
    skillHash: "new",
    contentSig: "newsig",
    hashFormat: "jcs1",
    fileSigs: [["LIVE/path.md", "newsha"]],
    mode: "git",
  };

  /** Unwrap a successful migration; fails loudly if the helper refused. */
  const ok = (r: ReturnType<typeof migrateFingerprint>) => {
    if ("error" in r) throw new Error(`expected a migration, got refusal: ${r.error}`);
    return r.fingerprint;
  };

  it("preserves promptAssetsHash and labelProvenance — a spread DELETED both", () => {
    // `buildFingerprint` cannot produce promptAssetsHash without a baseline object (rehash passes none)
    // and never produces labelProvenance at all, so `{ ...live }` silently dropped the provenance guards.
    const out = ok(migrateFingerprint(recorded, live));
    expect(out.promptAssetsHash).toBe("491afe2862dc67ea");
    expect(out.labelProvenance).toEqual(recorded.labelProvenance);
  });

  it("takes the new digests and the new format", () => {
    const out = ok(migrateFingerprint(recorded, live));
    expect(out.skillHash).toBe("new");
    expect(out.contentSig).toBe("newsig");
    expect(out.hashFormat).toBe("jcs1");
  });

  it("keeps the RECORDED (redacted) fileSigs paths, swapping only digests", () => {
    // Cassette paths are redacted before writing; rebuilding from a live walk would put unredacted source
    // paths back into a redacted cassette.
    expect(ok(migrateFingerprint(recorded, live)).fileSigs).toEqual([["redacted/path.md", "newsha"]]);
  });

  it("REFUSES when the arrays do not align, rather than 'repairing' them", () => {
    const misaligned: Fingerprint = {
      ...live,
      fileSigs: [
        ["a", "1"],
        ["b", "2"],
      ],
    };
    // An aggregate digest proof says nothing about whether the manifest array is well-formed — and
    // silently keeping the OLD per-file digests beside a NEW skillHash would stamp a fingerprint that
    // contradicts itself. REFUSE instead, so `rehash` reports an error rather than "migrated".
    const r = migrateFingerprint(recorded, misaligned);
    expect("error" in r && r.error).toMatch(/entry count differs/);
  });

  it("preserves ABSENCE — never materialises a fresh live list; and refuses a one-sided manifest", () => {
    // A cassette that RECORDED a manifest but whose tree can no longer produce one is inconsistent —
    // refuse. The reverse is legitimate (pre-v5, or fileSigsOmitted above the cap) and must still migrate.
    const { fileSigs: _noLive, ...liveWithout } = live;
    expect("error" in migrateFingerprint(recorded, liveWithout as Fingerprint)).toBe(true);
    expect("error" in migrateFingerprint({ ...recorded, fileSigs: undefined } as Fingerprint, live)).toBe(false);
    const { fileSigs: _drop, ...noSigs } = recorded;
    const { fileSigs: _dropLive, ...liveNoSigs } = live;
    expect(ok(migrateFingerprint(noSigs as Fingerprint, liveNoSigs as Fingerprint)).fileSigs).toBeUndefined();
  });
});

describe.skipIf(!existsSync(CLI))("rehash — the migration path the epoch makes mandatory", () => {
  /** A pre-epoch cassette on disk, with its session either alongside it or deliberately elsewhere. */
  function preEpochCassette(opts: { moveAway?: boolean } = {}): { file: string; sessionPath: string } {
    const root = unsortedRoot();
    const sessionPath = join(root, "session.yaml");
    writeFileSync(sessionPath, `skills:\n  local:\n    - ${root}\n`);
    const fp = buildFingerprint(sessionPath, LIVE_BASELINE, root);
    // Recompute what the LEGACY algorithm would have recorded, so the cassette is a faithful pre-epoch artifact.
    const legacy = foldSnapshot(skillHashSnapshot([root]), "legacy");
    const dir = opts.moveAway ? mkdtempSync(join(tmpdir(), "epoch-moved-")) : root;
    const file = join(dir, "c.cassette.json");
    // A real cassette stores `session:` RELATIVE to its own directory — which is exactly why relocation
    // breaks resolution. An absolute path would survive any move and make the "moved" case vacuous.
    const recordedSession = opts.moveAway ? "./session.yaml" : sessionPath;
    writeFileSync(
      file,
      JSON.stringify(
        {
          cassetteVersion: EPOCH - 1, // pre-epoch by construction
          scenario: { name: "c", baseline: LIVE_BASELINE, session: recordedSession, fidelity: "container", prompt: "hi", answers: [] },
          events: [],
          fingerprint: { ...fp, skillHash: legacy, hashFormat: undefined },
        },
        null,
        2,
      ),
    );
    return { file, sessionPath };
  }

  const rehash = (args: string[]) => {
    const r = spawnSync("node", [CLI, "rehash", "--output-format", "json", ...args], { encoding: "utf8" });
    return JSON.parse(r.stdout.trim()) as { results: { action: string; reason: string }[] };
  };

  it("migrates a provable pre-epoch cassette and stamps the format", () => {
    const { file } = preEpochCassette();
    const res0 = rehash([join(file, "..")]).results[0];
    expect(res0.action, res0.reason).toBe("migrated");
    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    expect(onDisk.cassetteVersion).toBe(EPOCH);
    expect(onDisk.fingerprint.hashFormat).toBe("jcs1");
  });

  it("REFUSES when the content changed — the proof is a proof, not a formality", () => {
    const { file } = preEpochCassette();
    writeFileSync(join(file, "..", "skills", "s", "SKILL.md"), "# CHANGED\n");
    const r = rehash([join(file, "..")]).results[0];
    expect(r.action).toBe("error");
    expect(r.reason).toMatch(/legacy skillHash mismatch/);
  });

  it("REFUSES on empty-directory drift — which contentSig alone cannot see", () => {
    // `skillHash` folds a `D:` marker for every directory; `contentSig` (pre-v5) folded only files and
    // links. A contentSig-based proof would have vouched for this.
    const { file } = preEpochCassette();
    mkdirSync(join(file, "..", "brand-new-empty-dir"));
    expect(rehash([join(file, "..")]).results[0].action).toBe("error");
  });

  it("a MOVED cassette cannot migrate without --session, and CAN with it", () => {
    const { file, sessionPath } = preEpochCassette({ moveAway: true });
    // The recorded session cannot be resolved from the cassette's new directory…
    expect(rehash([join(file, "..")]).results[0].action).toBe("error");
    // …and this is the remedy. Without it, the epoch would leave moved cassettes permanently failing.
    const r = spawnSync("node", [CLI, "rehash", "--output-format", "json", file, "--session", sessionPath], { encoding: "utf8" });
    expect(JSON.parse(r.stdout.trim()).results[0].action).toBe("migrated");
  });

  it("--session refuses a DIRECTORY — each cassette may resolve differently", () => {
    const { sessionPath } = preEpochCassette({ moveAway: true });
    const r = spawnSync("node", [CLI, "rehash", "--output-format", "json", tmpdir(), "--session", sessionPath], { encoding: "utf8" });
    expect(r.status).not.toBe(0);
  });
});

describe.skipIf(!existsSync(CLI))("the version/format invariant is enforced at the READ boundary", () => {
  it("rejects a current-version cassette whose fingerprint omits hashFormat", () => {
    const dir = mkdtempSync(join(tmpdir(), "epoch-inv-"));
    const file = join(dir, "c.cassette.json");
    writeFileSync(
      file,
      JSON.stringify({
        cassetteVersion: CASSETTE_VERSION,
        scenario: { name: "c", baseline: "latest", session: "s.yaml", fidelity: "container", prompt: "hi", answers: [] },
        events: [],
        fingerprint: { baseline: "latest", skillHash: "abc" }, // stamped current, but says nothing about format
      }),
    );
    const r = spawnSync("node", [CLI, "replay", file], { encoding: "utf8" });
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/hashFormat/);
  });
});
