import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  CASSETTE_VERSION,
  KEY_REQUIRED_VERSION,
  requiredVersionFor,
  cassetteSchemaUrl,
  checkStaleness,
  replayCassette,
  buildFingerprint,
  type Cassette,
} from "../src/run/cassette.js";
import { ScenarioObject } from "../src/types.js";
import { loadBaseline } from "../src/baseline.js";

// `cassetteVersion` means "the minimum format version a reader needs to INTERPRET this cassette
// correctly", not "which recorder wrote it". An earlier design of this mechanism keyed the stamp on KEY
// PRESENCE and was falsified: `lane` is `.default("local")`, so EVERY parsed scenario carries the key,
// and a presence check would stamp v11 on every cassette — the unconditional bump this whole design
// exists to avoid. This file pins the corrected value-aware mechanism.

const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);

describe("requiredVersionFor — value-aware, not key-presence", () => {
  it("lane: remote requires v11", () => {
    const s = ScenarioObject.parse({ prompt: "x", lane: "remote" });
    expect(requiredVersionFor(s)).toBe(11);
  });

  // The two load-bearing cases (v1 passed the v11 case above and failed both of these).
  it("lane: local requires v10, NOT v11", () => {
    const s = ScenarioObject.parse({ prompt: "x", lane: "local" });
    expect(requiredVersionFor(s)).toBe(10);
  });

  it(
    "lane OMITTED requires v10, NOT v11 — `lane` defaults to 'local' via Zod, so the parsed scenario " +
      "carries the key regardless; a key-presence predicate would wrongly stamp v11 here",
    () => {
      const s = ScenarioObject.parse({ prompt: "x" });
      expect(s.lane).toBe("local"); // sanity: the default really is present on every parsed scenario
      expect(requiredVersionFor(s)).toBe(10);
    },
  );

  it("an unparsed/loose scenario object (as rehash reads off disk) is handled the same way", () => {
    expect(requiredVersionFor({ prompt: "x", lane: "remote" })).toBe(11);
    expect(requiredVersionFor({ prompt: "x" })).toBe(10); // no `lane` key at all — still 0, not a bump
    expect(requiredVersionFor(null)).toBe(10); // defensive: never throws on a malformed on-disk value
  });
});

describe("KEY_REQUIRED_VERSION coverage — every ScenarioObject key must be classified", () => {
  // The guard from the spec: adding a scenario key without deciding its cassette-version impact must red
  // CI, not silently default to 0 (a sparse map + `?? 0` fallback would reintroduce exactly that gap).
  it("has an entry for every one of ScenarioObject.shape's keys", () => {
    const scenarioKeys = Object.keys(ScenarioObject.shape);
    expect(scenarioKeys.length).toBe(15); // pins the count so a schema addition is visible here too
    for (const key of scenarioKeys) {
      expect(KEY_REQUIRED_VERSION).toHaveProperty(key);
    }
  });

  it("has no stray entries beyond ScenarioObject's own keys (keeps the map honest both ways)", () => {
    const scenarioKeys = new Set(Object.keys(ScenarioObject.shape));
    for (const key of Object.keys(KEY_REQUIRED_VERSION)) {
      expect(scenarioKeys.has(key)).toBe(true);
    }
  });
});

describe("$schema tracks the STAMPED version, not the build max", () => {
  // Both write sites (record's `base.$schema` and rehash's `updated.$schema`) call this exact function
  // with the per-scenario stamped version — see src/run/cassette.ts. record itself needs a live agent to
  // exercise (out of the token-free/spawn-free default suite, same rationale test/rehash.test.ts already
  // documents for its own happy path); the rehash tests below prove the on-disk result end-to-end for
  // both a v10 and a v11 stamp, sharing this same helper.
  it("selects the schema URL per stamped version", () => {
    expect(cassetteSchemaUrl(10)).toMatch(/cassette\.v10\.json$/);
    expect(cassetteSchemaUrl(11)).toMatch(/cassette\.v11\.json$/);
  });
});

describe("staleness — hash-format epoch, not CASSETTE_VERSION", () => {
  // v11 (like v9 and v10 before it) changes cassette SHAPE, not hashing. A v10 cassette with genuine skill
  // drift must fall into the drift-bucket attribution, not the "recorded under an older hash format"
  // branch (which would swallow the per-file detail — see the P8 spec's "two downstream assumptions").
  it("a v10 cassette with genuine skill drift reports drift buckets, not 'older hash format'", () => {
    const root = mkdtempSync(join(tmpdir(), "cwh-epoch-"));
    const skillDir = join(root, "skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# s\n");
    const sessionPath = join(root, "session.yaml");
    writeFileSync(sessionPath, `skills:\n  local:\n    - ./skill\n`);

    const cassette = {
      cassetteVersion: 10, // >= HASH_FORMAT_EPOCH (8) — no hashing change happened at/after this recording
      scenario: {
        name: "s",
        baseline: "latest",
        session: sessionPath,
        fidelity: "container" as const,
        prompt: "hi",
        answers: [],
        expect_denied: [],
        assert: [],
      },
      events: [],
      fingerprint: {
        baseline: "99.0.0",
        // deliberately wrong vs. the real skill dir content, to force a mismatch
        skillHash: "0000000000000000000000000000000000000000000000000000000000000000",
      },
    } as unknown as Cassette;

    const msgs = checkStaleness(cassette, root);
    const skillMsg = msgs.find((m) => /changed since|contents changed/.test(m));
    expect(skillMsg).toBeDefined();
    expect(skillMsg).not.toMatch(/older hash format/i);
  });
});

// A cassette one version beyond this build simulates "a vN+1 cassette on a reader capped at vN" without
// requiring an actual older install (the spec's own instruction) — the exact same mechanism a real v11
// cassette hits on a pre-P8 (capped-at-v10) reader.
describe("a future-version cassette is refused by a capped reader; the escape hatch reopens the hole", () => {
  it("replayCassette fails by default; --best-effort-future-cassette overrides", async () => {
    const events = [
      JSON.stringify({ type: "system", subtype: "init", tools: ["Write"] }),
      JSON.stringify({ type: "result", subtype: "success", is_error: false }),
    ];
    const future = {
      cassetteVersion: CASSETTE_VERSION + 1,
      scenario: {
        name: "c",
        baseline: "latest",
        session: "(inline)",
        fidelity: "container" as const,
        prompt: "hi",
        answers: [],
        expect_denied: [],
        assert: [{ result: "success" as const }],
      },
      events,
    } as unknown as Cassette;

    const def = await replayCassette(future);
    expect(def.assertions.some((a) => !a.pass && /cassette format too new/.test(a.message ?? ""))).toBe(true);

    // --best-effort-future-cassette opts back into replaying it — the documented, deliberate escape hatch.
    const effort = await replayCassette(future, [], { bestEffortFutureCassette: true });
    expect(effort.assertions.some((a) => !a.pass && /cassette format too new/.test(a.message ?? ""))).toBe(false);
  });

  it("verify-cassettes has no escape hatch — a future-version cassette always fails the gate", () => {
    if (!can) return;
    const cwd = mkdtempSync(join(tmpdir(), "cwh-p8-verify-"));
    const body = {
      cassetteVersion: CASSETTE_VERSION + 1,
      scenario: {
        name: "c",
        baseline: "latest",
        session: "(inline)",
        fidelity: "container",
        prompt: "hi",
        answers: [],
        expect_denied: [],
        assert: [],
      },
      events: [
        JSON.stringify({ type: "system", subtype: "init" }),
        JSON.stringify({ type: "result", subtype: "success", is_error: false }),
      ],
    };
    writeFileSync(join(cwd, "c.cassette.json"), JSON.stringify(body));
    const r = spawnSync("node", [CLI, "verify-cassettes", "c.cassette.json", "--output-format", "json"], { encoding: "utf8", cwd });
    expect(r.status).not.toBe(0);
    expect(r.stdout).toMatch(/newer than this harness understands/);
  });
});

function makeSkillDir(files: Record<string, string>): string {
  const d = mkdtempSync(join(tmpdir(), "cwh-p8-skill-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(d, rel);
    mkdirSync(join(d, rel, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return d;
}

// The write-site fix: `rehash` must stamp `requiredVersionFor(scenario)`, not CASSETTE_VERSION
// unconditionally — otherwise `rehash <dir>` over a directory of clean, lane-free v10 cassettes bumps
// every one to v11, reintroducing the blanket cost P8 exists to avoid, via the very command the plan
// names as the recovery path. This is the counter-test the P8 spec calls out as EXPECTED TO FAIL against
// pre-fix code.
describe.skipIf(!can)("rehash — conditional re-stamp", () => {
  const liveBaseline = loadBaseline("latest").appVersion;

  function cassetteFixture(lane: "local" | "remote" | undefined): string {
    const skillDir = makeSkillDir({ "SKILL.md": "# probe\ndo a thing\n" });
    const dir = mkdtempSync(join(tmpdir(), "cwh-p8-rehash-"));
    const sessionPath = join(dir, "session.yaml");
    writeFileSync(sessionPath, `skills:\n  local:\n    - ${skillDir}\n`);
    // Compute the fingerprint the same way `rehash` will (absolute session path ⇒ cassetteDir irrelevant),
    // so the content-unchanged gate passes and the migration reaches the version-stamp logic under test.
    const fp = buildFingerprint(sessionPath, liveBaseline, dir, undefined);
    expect(fp.contentSig).toBeTruthy(); // sanity: skill dir resolved
    const scenario: Record<string, unknown> = {
      name: "s",
      baseline: liveBaseline,
      session: sessionPath,
      fidelity: "container",
      prompt: "hi",
      answers: [],
      expect_denied: [],
      assert: [],
    };
    if (lane !== undefined) scenario.lane = lane;
    const body = {
      cassetteVersion: 10,
      scenario,
      events: [
        JSON.stringify({ type: "system", subtype: "init" }),
        JSON.stringify({ type: "result", subtype: "success", is_error: false }),
      ],
      fingerprint: { baseline: liveBaseline, skillHash: fp.skillHash, contentSig: fp.contentSig },
    };
    writeFileSync(join(dir, "s.cassette.json"), JSON.stringify(body));
    return dir;
  }

  it("leaves a lane-free v10 cassette at v10 — does NOT bump to v11", () => {
    const dir = cassetteFixture(undefined);
    const r = spawnSync("node", [CLI, "rehash", "--output-format", "json", dir], { encoding: "utf8" });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.results[0].action).toBe("skipped");
    expect(out.results[0].reason).toMatch(/already at v10/);
    const onDisk = JSON.parse(readFileSync(join(dir, "s.cassette.json"), "utf8"));
    expect(onDisk.cassetteVersion).toBe(10);
    expect(onDisk.$schema).toBeUndefined(); // untouched (skipped ⇒ file not rewritten at all)
  });

  it("lane: local (explicit) also leaves a v10 cassette at v10", () => {
    const dir = cassetteFixture("local");
    const r = spawnSync("node", [CLI, "rehash", "--output-format", "json", dir], { encoding: "utf8" });
    const out = JSON.parse(r.stdout.trim());
    expect(out.results[0].action).toBe("skipped");
    expect(out.results[0].reason).toMatch(/already at v10/);
  });

  it("its partner: re-stamps a lane: remote v10 cassette to v11", () => {
    const dir = cassetteFixture("remote");
    const r = spawnSync("node", [CLI, "rehash", "--output-format", "json", dir], { encoding: "utf8" });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim());
    expect(out.results[0].action).toBe("migrated");
    expect(out.results[0].reason).toMatch(/v10 → v11/);
    const onDisk = JSON.parse(readFileSync(join(dir, "s.cassette.json"), "utf8"));
    expect(onDisk.cassetteVersion).toBe(11);
    expect(onDisk.$schema).toMatch(/cassette\.v11\.json$/);
  });
});
