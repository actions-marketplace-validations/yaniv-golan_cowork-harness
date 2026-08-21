import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readCassette, readCassetteForScan, scanCassette } from "../src/run/cassette.js";

// The read-boundary split: whether a transcript can be READ and whether a cassette is VALID are different
// questions, and only the first one gates a privacy scan.
//
// Before this, `verifyOneCassette` returned early on any shape failure and `scanCassette` — on the very
// next line — never ran. A file too broken to replay was reported with zero findings, which reads in every
// summary as "0 PII finding(s)". That is a clean-looking number from an instrument that never ran, and a
// file too broken to replay is exactly the kind of file a leak arrives in.
//
// `readCassette` is deliberately NOT loosened here (replay, staleness and the hash-format epoch's
// version/hashFormat invariant all depend on its strictness). `readCassetteForScan` is a separate,
// narrower door.

const CLI = resolve("dist/cli.js");

/** A cassette with NO `scenario.session` — invalid shape, readable transcript. */
function malformed(extra: Record<string, unknown> = {}, events: unknown[] = []): Record<string, unknown> {
  return {
    generator: "cowork-harness",
    cassetteVersion: 10,
    effectiveFidelity: "hostloop",
    scenario: { name: "leaky", prompt: "go", fidelity: "hostloop" },
    events: events.map((e) => JSON.stringify(e)),
    ...extra,
  };
}

const HOST_INVENTORY_INIT = {
  type: "system",
  subtype: "init",
  session_id: "x",
  mcp_servers: [{ name: "acme-internal-crm" }, { name: "lool-vc-affinity" }],
  account: { email: "someone@acme-corp.com", organization: "Acme Internal" },
  agents: [{ name: "acme:secret-reviewer" }],
};

function write(dir: string, name: string, body: unknown): string {
  const p = join(dir, name);
  writeFileSync(p, typeof body === "string" ? body : JSON.stringify(body, null, 2));
  return p;
}

describe("readCassette stays STRICT — the split must not loosen it", () => {
  it("still rejects a cassette with no scenario.session", () => {
    const dir = mkdtempSync(join(tmpdir(), "cwh-split-"));
    const p = write(dir, "x.cassette.json", malformed());
    const rc = readCassette(p);
    expect("error" in rc).toBe(true);
    expect("error" in rc && rc.error).toMatch(/invalid cassette shape.*scenario\.session/);
  });
});

describe("readCassetteForScan — reads a transcript out of a document that does NOT validate", () => {
  it("salvages a scannable projection from a shape-invalid cassette", () => {
    const dir = mkdtempSync(join(tmpdir(), "cwh-split-"));
    const p = write(dir, "x.cassette.json", malformed({}, [HOST_INVENTORY_INIT]));
    const r = readCassetteForScan(p);
    expect("scannable" in r).toBe(true);
  });

  it("THE POINT: a malformed cassette carrying host inventory is FOUND, where it used to report zero", () => {
    // Constructed as the disconfirming case first: if the salvaged scan could not fail, a green result
    // above would mean nothing. This file is invalid AND leaking; every one of these findings was
    // invisible before the split.
    const dir = mkdtempSync(join(tmpdir(), "cwh-split-"));
    const p = write(dir, "x.cassette.json", malformed({}, [HOST_INVENTORY_INIT]));
    const r = readCassetteForScan(p);
    if (!("scannable" in r)) throw new Error(r.error);
    const findings = scanCassette(r.scannable, []);
    const classes = findings.map((f) => f.cls);
    expect(classes).toContain("host-inventory");
    expect(findings.some((f) => f.sample?.includes("acme-internal-crm"))).toBe(true);
    expect(findings.some((f) => f.sample?.includes("lool-vc-affinity"))).toBe(true);
    expect(classes).toContain("email");
  });

  it("refuses when there is no transcript to scan, rather than reporting clean", () => {
    // "No findings" and "nothing to look at" must never be the same answer.
    const dir = mkdtempSync(join(tmpdir(), "cwh-split-"));
    for (const [name, body] of [
      ["no-events.cassette.json", { generator: "cowork-harness", scenario: { prompt: "x" } }],
      ["events-not-strings.cassette.json", { events: [{ not: "a string" }] }],
      ["not-json.cassette.json", "{ this is not json"],
      ["json-array.cassette.json", [1, 2, 3]],
      ["json-scalar.cassette.json", '"just a string"'],
    ] as const) {
      const r = readCassetteForScan(write(dir, name, body));
      expect("error" in r, `${name} was accepted as scannable`).toBe(true);
    }
  });

  it("never throws on a partially-corrupt document — a crash reads as 'the rest were fine'", () => {
    const dir = mkdtempSync(join(tmpdir(), "cwh-split-"));
    const p = write(dir, "x.cassette.json", {
      events: ["{}"],
      scenario: "not an object",
      artifacts: [null, 42, { path: 7 }, { path: "ok/x.md", body: "hi" }],
      fingerprint: { skillSources: "not an array", fileSigs: [null, ["a", "b"], 5] },
      userVisibleRoots: [1, 2],
      environment: { agentImage: 5 },
      controlOut: "not an array",
    });
    const r = readCassetteForScan(p);
    expect("scannable" in r).toBe(true);
    if (!("scannable" in r)) return;
    expect(() => scanCassette(r.scannable, [])).not.toThrow();
    // Malformed sub-structures are DROPPED, not passed through half-typed.
    expect(r.scannable.artifacts).toHaveLength(1);
    expect(r.scannable.fingerprint?.fileSigs).toEqual([["a", "b"]]);
    expect(r.scannable.controlOut).toBeUndefined();
  });

  it("FAILS CLOSED on a tier it does not recognize, so the structural scan still runs", () => {
    // `scanCassette` exempts a positively-sealed tier and scans everything else INCLUDING undefined — but
    // it tests set membership, so an arbitrary string is neither undefined nor host-inheriting and would
    // SKIP the structural host-inventory scan. The strict reader can't produce that (Zod validates the
    // literal union); this reader can, because malformed input is its whole job.
    const dir = mkdtempSync(join(tmpdir(), "cwh-split-"));
    for (const bogus of ["garbage", "containerr", "CONTAINER", ""]) {
      const p = write(dir, `t-${bogus || "empty"}.cassette.json`, {
        scenario: { prompt: "x", fidelity: bogus },
        effectiveFidelity: bogus,
        events: [JSON.stringify(HOST_INVENTORY_INIT)],
      });
      const r = readCassetteForScan(p);
      if (!("scannable" in r)) throw new Error("expected scannable");
      expect(r.scannable.scenario.fidelity, `tier '${bogus}' leaked through`).toBeUndefined();
      expect(r.scannable.effectiveFidelity).toBeUndefined();
      const classes = scanCassette(r.scannable, []).map((f) => f.cls);
      expect(classes, `tier '${bogus}' skipped the structural scan`).toContain("host-inventory");
    }
  });

  it("still EXEMPTS a genuinely sealed tier, so the fail-closed rule did not become 'scan everything'", () => {
    const dir = mkdtempSync(join(tmpdir(), "cwh-split-"));
    const p = write(dir, "sealed.cassette.json", {
      scenario: { prompt: "x", fidelity: "container" },
      effectiveFidelity: "container",
      events: [JSON.stringify(HOST_INVENTORY_INIT)],
    });
    const r = readCassetteForScan(p);
    if (!("scannable" in r)) throw new Error("expected scannable");
    expect(r.scannable.effectiveFidelity).toBe("container");
    expect(scanCassette(r.scannable, []).map((f) => f.cls)).not.toContain("host-inventory");
  });
});

describe("verify-cassettes reports the split honestly (CLI)", () => {
  const built = existsSync(CLI);
  beforeAll(() => {
    if (!built) throw new Error("dist/cli.js missing — run `npm run build`; these cases must not silently skip");
  });

  const runJson = (p: string, ...extra: string[]) => {
    let out = "";
    let code = 0;
    try {
      out = execFileSync("node", [CLI, "verify-cassettes", p, "--output-format", "json", ...extra], { encoding: "utf8", stdio: "pipe" });
    } catch (e) {
      const err = e as { status?: number; stdout?: string };
      code = err.status ?? -1;
      out = err.stdout ?? "";
    }
    return { code, result: (JSON.parse(out) as { results: Record<string, unknown>[] }).results[0] };
  };

  it("a shape-invalid but scannable cassette: privacyScanned true, error still reported", () => {
    const dir = mkdtempSync(join(tmpdir(), "cwh-split-"));
    const p = write(dir, "x.cassette.json", malformed({}, [{ type: "system", subtype: "init", session_id: "x" }]));
    const { result } = runJson(p);
    expect(result.privacyScanned).toBe(true);
    expect(result.error).toMatch(/invalid cassette shape/);
  });

  it("a leaking shape-invalid cassette escalates to exit 1, not exit 3", () => {
    // Worst-wins: a real finding outranks "could not verify". Before the split this exited 3 with zero
    // findings, so a gate keyed on exit codes saw 'unverifiable' where the truth was 'leaking'.
    const dir = mkdtempSync(join(tmpdir(), "cwh-split-"));
    const p = write(dir, "x.cassette.json", malformed({}, [HOST_INVENTORY_INIT]));
    const { code, result } = runJson(p);
    expect(code).toBe(1);
    expect(result.privacyScanned).toBe(true);
    expect((result.findings as unknown[]).length).toBeGreaterThan(0);
  });

  it("an unscannable cassette reports privacyScanned FALSE alongside its zero findings", () => {
    const dir = mkdtempSync(join(tmpdir(), "cwh-split-"));
    const p = write(dir, "x.cassette.json", { generator: "cowork-harness", scenario: { prompt: "x" } });
    const { result } = runJson(p);
    expect(result.privacyScanned).toBe(false);
    expect(result.findings).toEqual([]);
  });

  it("--skip-privacy reports privacyScanned FALSE — 'we did not look' is not 'clean'", () => {
    const { result } = runJson("examples/replays/example-multiselect-gate.cassette.json", "--skip-privacy");
    expect(result.privacyScanned).toBe(false);
  });

  it("an ordinary clean cassette reports privacyScanned TRUE", () => {
    const { result } = runJson("examples/replays/example-multiselect-gate.cassette.json");
    expect(result.privacyScanned).toBe(true);
  });

  it("the repo's own eval fixture is now SCANNED, which is what removed the commit friction", () => {
    const { result } = runJson("test/evals/files/report-check.cassette.json");
    expect(result.privacyScanned).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.error).toMatch(/invalid cassette shape/);
  });
});
