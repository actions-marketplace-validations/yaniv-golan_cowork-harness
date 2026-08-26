import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostInventoryPreflight, classifyRecordLeak, quarantineCassette, type ScannableCassette } from "../src/run/cassette.js";

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

// THE SPLIT, END TO END. Until 2.2.0 `--allow-host-inventory-fixture` did two jobs: it bypassed the
// pre-flight (whose stated precondition — "use only when the session has no personal MCP servers or
// plugins" — is not decidable by the operator) AND downgraded the write-time scan's refusal to a warning.
// So the operator who passed it to get past the undecidable check also disabled the measured net that
// would have caught a real leak.
//
// The two layers run at DIFFERENT TIMES (pre-flight before the spend, scan after the recording exists), so
// no single function represents the composition and there is nothing to call. This drives both real
// functions in the order and with the arguments `recordScenarioObject` uses. What keeps that mirror honest
// is the pair of structural pins in the next describe block, which assert that BOTH real call sites pass
// exactly these arguments — a drift in either one fails there. (The first version of this comment claimed a
// pair while only one pin existed: `classifyRecordLeak`'s. Swapping the pre-flight's argument to the
// findings flag then made `--allow-host-inventory-fixture` a dead flag and quietly turned the findings
// consent into a pre-spend bypass too — one flag doing two jobs again — with a fully green suite. Measured.)
// Weaker than a spawn-driven test; far stronger than the source-text match that was the only coverage.
describe("the two flags are two decisions — neither substitutes for the other", () => {
  /** Mirrors recordScenarioObject: pre-flight first (may refuse before any spend), then, if we got past it,
   *  the write-time scan on the finished recording. */
  function record(flags: { fixture?: boolean; findings?: boolean }) {
    const path = join(repoDir(), "x.cassette.json");
    const scenario = { name: "s", prompt: "go", fidelity: "hostloop", assert: [] } as unknown as Parameters<
      typeof hostInventoryPreflight
    >[0];
    const pre = hostInventoryPreflight(scenario, path, flags.fixture === true);
    if (pre.kind === "refuse") return { stage: "preflight-refused" as const, detail: pre.message };
    const leak = classifyRecordLeak(cassette([HOST_INVENTORY_INIT]), path, flags.findings === true);
    return { stage: leak.kind === "ok" ? ("written" as const) : (leak.kind as string), detail: "detail" in leak ? leak.detail : "" };
  }

  it("no flags: refused at the pre-flight, before a single token is spent", () => {
    expect(record({}).stage).toBe("preflight-refused");
  });

  // THE REGRESSION THIS SPLIT EXISTS FOR. In 2.2.0 this combination WROTE the leaking cassette with a
  // warning. It must now quarantine.
  it("--allow-host-inventory-fixture alone: gets past the pre-flight and is then QUARANTINED by the scan", () => {
    const r = record({ fixture: true });
    expect(r.stage).toBe("quarantine");
    expect(r.detail).toMatch(/acme-internal-crm/);
  });

  it("--allow-host-inventory-findings is the only thing that writes a flagged recording", () => {
    const r = record({ fixture: true, findings: true });
    expect(r.stage).toBe("override");
  });

  // The findings flag is NOT a back door around the pre-flight: it consents to a measured finding, not to
  // skipping the pre-spend check. Passing it alone must still refuse before spending.
  it("--allow-host-inventory-findings alone does NOT bypass the pre-flight", () => {
    expect(record({ findings: true }).stage).toBe("preflight-refused");
  });

  it("the pre-flight refusal no longer asserts a precondition the operator cannot check", () => {
    const msg = record({}).detail;
    expect(msg).not.toMatch(/if this session has no personal MCP servers or plugins/);
    expect(msg).toMatch(/the scan is the actual gate/);
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
    expect(src).toMatch(/const leak = classifyRecordLeak\(cassette, cassettePath, opts\.allowHostInventoryFindings === true\)/);
    for (const kind of ["override", "outside-repo", "quarantine"]) {
      expect(src, `verdict kind '${kind}' is unhandled at the call site`).toContain(`leak.kind === "${kind}"`);
    }
  });

  // THE SPLIT. Until 2.2.0 one flag did both jobs, so an operator who passed it to get past a
  // precondition they could not check also disabled the measured scan — the escape hatch defeated the
  // guard that was working. The pre-flight bypass must never reach this call.
  // The OTHER half of the split, and the one that was unpinned. Without this, moving the pre-flight to the
  // findings flag passes every test: the fixture flag becomes inert and the findings flag silently becomes a
  // pre-spend bypass as well as a write-time override.
  it("the pre-flight is bypassed by --allow-host-inventory-fixture, NOT by the findings flag", () => {
    // Anchor on the ARGUMENTS, not the name: a bare /hostInventoryPreflight\(...\)/ matches the function
    // DEFINITION first (whose third parameter is `allowed`), so the pin passes and fails for reasons that
    // have nothing to do with the call site. Caught by mutation-testing this very assertion.
    const call = src.match(/hostInventoryPreflight\(\s*scenario,\s*plannedCassettePath,[^)]*\)/)![0];
    expect(call).toContain("allowHostInventoryFixture");
    expect(call, "the findings consent must never become a pre-spend bypass").not.toContain("allowHostInventoryFindings");
  });

  it("the write-time scan is overridden by --allow-host-inventory-findings, NOT by the pre-flight bypass", () => {
    const call = src.match(/const leak = classifyRecordLeak\([^)]*\)/)![0];
    expect(call).toContain("allowHostInventoryFindings");
    expect(call, "the pre-flight bypass must not wave through a measured finding").not.toContain("allowHostInventoryFixture");
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
