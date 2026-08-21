import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyRecordLeak, quarantineCassette, type ScannableCassette } from "../src/run/cassette.js";

// Record-time privacy scanning, with a QUARANTINE policy.
//
// `hostInventoryPreflight` already refuses before the paid spawn, and this does not replace it — but that
// check reads the TIER and the DESTINATION PATH, never the resulting bytes, so it is a prediction and can
// be wrong in both directions. Until this existed, `scanCassette` had exactly one production call site
// (`verify-cassettes`), which runs at COMMIT time at the earliest.
//
// Quarantine rather than discard, because the recording already cost real money: throwing it away is the
// most expensive possible answer and the one most likely to end in "just commit it anyway". Write it where
// it cannot be committed, say exactly where and why, and fail.

const HOST_INVENTORY_INIT = JSON.stringify({
  type: "system",
  subtype: "init",
  session_id: "x",
  mcp_servers: [{ name: "acme-internal-crm" }],
  account: { email: "someone@acme-corp.com", organization: "Acme Internal" },
});

function cassette(events: string[], fidelity = "hostloop"): ScannableCassette {
  return { events, scenario: { name: "s", prompt: "go", fidelity }, effectiveFidelity: fidelity };
}

/** A directory that IS a git repo, and one that is not. `isRepoVisiblePath` asks git, so these must be real. */
function repoDir(): string {
  const d = mkdtempSync(join(tmpdir(), "cwh-q-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: d, stdio: "pipe" });
  return d;
}
const plainDir = () => mkdtempSync(join(tmpdir(), "cwh-q-plain-"));

const savedRunsDir = process.env.COWORK_HARNESS_RUNS_DIR;
afterEach(() => {
  if (savedRunsDir === undefined) delete process.env.COWORK_HARNESS_RUNS_DIR;
  else process.env.COWORK_HARNESS_RUNS_DIR = savedRunsDir;
});

describe("classifyRecordLeak — what triggers a quarantine, and what must not", () => {
  it("quarantines a recording carrying host inventory into a repo-visible path", () => {
    const v = classifyRecordLeak(cassette([HOST_INVENTORY_INIT]), join(repoDir(), "x.cassette.json"), false);
    expect(v.kind).toBe("quarantine");
    expect(v.kind !== "ok" && v.detail).toMatch(/acme-internal-crm/);
  });

  it("does NOT quarantine content findings — a cap-table fixture is SUPPOSED to have currency and domains", () => {
    // The whole gate becomes decoration if it fires on legitimate scenario content: the operator learns to
    // pass the escape flag by reflex. Only the machine-identity classes trigger.
    const contentful = JSON.stringify({
      type: "assistant",
      message: {
        content: [{ type: "text", text: "ACME raised $12m; see acme-customer.com, ceo@acme-customer.com, /Users/dev/work/deck.pdf" }],
      },
    });
    const v = classifyRecordLeak(cassette([contentful]), join(repoDir(), "x.cassette.json"), false);
    expect(v.kind, "a content finding triggered a quarantine").toBe("ok");
  });

  it("a clean recording is ok", () => {
    const clean = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "done" }] } });
    expect(classifyRecordLeak(cassette([clean]), join(repoDir(), "x.cassette.json"), false).kind).toBe("ok");
  });

  it("does not quarantine outside a repo — nothing there publishes it by accident", () => {
    const v = classifyRecordLeak(cassette([HOST_INVENTORY_INIT]), join(plainDir(), "x.cassette.json"), false);
    expect(v.kind).toBe("outside-repo");
    expect(v.kind !== "ok" && v.detail).toMatch(/acme-internal-crm/);
  });

  it("honours --allow-host-inventory-fixture, but still reports WHAT it is publishing", () => {
    const v = classifyRecordLeak(cassette([HOST_INVENTORY_INIT]), join(repoDir(), "x.cassette.json"), true);
    expect(v.kind).toBe("override");
    expect(v.kind !== "ok" && v.detail, "an override went quiet about what it overrode").toMatch(/acme-internal-crm/);
  });

  it("a SEALED tier is exempt, because the agent cannot see the host to inherit from it", () => {
    const v = classifyRecordLeak(cassette([HOST_INVENTORY_INIT], "container"), join(repoDir(), "x.cassette.json"), false);
    expect(v.kind).toBe("ok");
  });
});

describe("quarantineCassette — where a leaking recording actually goes", () => {
  it("writes the recording plus a findings sibling, under the runs root", () => {
    const runs = plainDir();
    process.env.COWORK_HARNESS_RUNS_DIR = runs;
    const q = quarantineCassette(
      { events: ["x"] },
      "my scenario",
      "/repo/x.cassette.json",
      "hostloop",
      "  [host-inventory] events[0] — acme",
      "2026-08-21T10:00:00.000Z",
    );
    expect(q.fellBack).toBe(false);
    expect(q.path.startsWith(join(runs, "quarantine"))).toBe(true);
    expect(existsSync(q.path)).toBe(true);
    const notes = readFileSync(`${q.path}.findings.txt`, "utf8");
    expect(notes).toMatch(/intended path: \/repo\/x\.cassette\.json/);
    expect(notes).toMatch(/tier: hostloop/);
    expect(notes).toMatch(/acme/);
    // The recording itself is intact — quarantine is not deletion; the operator paid for this.
    expect(JSON.parse(readFileSync(q.path, "utf8"))).toEqual({ events: ["x"] });
  });

  it("does NOT quarantine into another committable location", () => {
    // If --run-dir points inside a working tree, writing there would be theatre: the leak is still one
    // `git add` from being published. Fall back to the OS temp dir and say so.
    const runs = join(repoDir(), "runs");
    mkdirSync(runs, { recursive: true });
    process.env.COWORK_HARNESS_RUNS_DIR = runs;
    const q = quarantineCassette({ events: ["x"] }, "s", "/repo/x.cassette.json", "hostloop", "d", "2026-08-21T10:00:00.000Z");
    expect(q.fellBack, "quarantined into a git repo").toBe(true);
    expect(q.path.startsWith(runs)).toBe(false);
    expect(existsSync(q.path)).toBe(true);
  });

  it("two quarantines of the same scenario do not clobber each other", () => {
    const runs = plainDir();
    process.env.COWORK_HARNESS_RUNS_DIR = runs;
    const a = quarantineCassette({ n: 1 }, "s", "/repo/x.json", "hostloop", "d", "2026-08-21T10:00:00.000Z");
    const b = quarantineCassette({ n: 2 }, "s", "/repo/x.json", "hostloop", "d", "2026-08-21T11:00:00.000Z");
    expect(a.path).not.toBe(b.path);
    expect(readdirSync(join(runs, "quarantine")).filter((f) => f.endsWith(".cassette.json"))).toHaveLength(2);
  });

  it("a scenario name with separators cannot escape the quarantine dir", () => {
    const runs = plainDir();
    process.env.COWORK_HARNESS_RUNS_DIR = runs;
    const q = quarantineCassette({}, "../../etc/passwd", "/repo/x.json", "hostloop", "d", "2026-08-21T10:00:00.000Z");
    expect(q.path.startsWith(join(runs, "quarantine"))).toBe(true);
    expect(q.path).not.toMatch(/\.\./);
  });
});

describe("the call site — STRUCTURAL only, and deliberately labelled as such", () => {
  // HONEST COVERAGE NOTE. Everything above tests the POLICY (`classifyRecordLeak`) and the EFFECT
  // (`quarantineCassette`) as pure units. What is NOT covered by an executed test is the WIRING: that
  // `recordScenarioObject` calls the policy, after redaction, before the write, and throws on a
  // `quarantine` verdict. That function needs a live `executeScenario` spawn to reach, which is why this
  // file follows the same split the repo already uses for `buildCassette` (see the note at the foot of
  // test/redact-cassette.test.ts). A structural guard is weaker than an executed one — it can only see
  // that the code is present, never that it runs — so it is labelled rather than counted as coverage.
  const src = readFileSync(join("src", "run", "cassette.ts"), "utf8");

  it("recordScenarioObject consults the policy and handles every verdict kind", () => {
    expect(src).toMatch(/const leak = classifyRecordLeak\(cassette, cassettePath, opts\.allowHostInventoryFixture === true\)/);
    for (const kind of ["override", "outside-repo", "quarantine"]) {
      expect(src, `verdict kind '${kind}' is unhandled at the call site`).toContain(`leak.kind === "${kind}"`);
    }
  });

  it("scans AFTER redaction and BEFORE the write — order is the whole correctness argument", () => {
    // Scanning pre-redaction bytes would quarantine recordings that are in fact clean (redaction is the
    // mechanism meant to remove this). Scanning after the write would leave the leaking file on disk at
    // the path the operator asked for, which is the one outcome quarantine exists to prevent.
    const redaction = src.indexOf("cassette = redacted;");
    const scan = src.indexOf("const leak = classifyRecordLeak(");
    const write = src.indexOf("writeFileAtomic(cassettePath, JSON.stringify(cassette, null, 2));");
    expect(redaction).toBeGreaterThan(-1);
    expect(scan).toBeGreaterThan(redaction);
    expect(write).toBeGreaterThan(scan);
  });

  it("the quarantine branch THROWS rather than falling through to the write", () => {
    const branch = src.slice(src.indexOf('leak.kind === "quarantine"'), src.indexOf("writeFileAtomic(cassettePath,"));
    expect(branch).toMatch(/throw new Error\(/);
    expect(branch).toMatch(/quarantineCassette\(/);
  });
});
