import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

// `record --dry-run` used to print a "✗ MISSING" token line and a bare "✗ <error>" agent line even though nothing failed — exit 0,
// nothing wrong, but a CI log reads it as a failure. This matters more since --dry-run is documented as
// the token-free LOADER check, where token/agent are irrelevant by construction.
//
// Fix has two parts, tested separately below:
//  1. the token/agent lines are reworded to read as an informational preview, not a failure.
//  2. `--quiet` (previously an accepted-but-noop flag on `record`) now suppresses that preview block —
//     but NEVER the `✗ broken:` per-file diagnostics (muting the loader check's only useful output would
//     gut the feature), and never changes an exit code.
//
// Entirely token-free: --dry-run never spawns the agent or spends. Token env vars are forced to empty
// string (not merely deleted) so the repo's own .env fallback — loadDotenv skips keys already present in
// process.env, even empty ones — can't leak a real local token into the "absent" branch (see
// test/cli-json.test.ts's `record: no token` test for the same pattern and its rationale).
const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);

function noTokenEnv(): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([k]) => !["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"].includes(k)),
    ),
    CLAUDE_CODE_OAUTH_TOKEN: "",
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_AUTH_TOKEN: "",
  };
}

function cli(args: string[], cwd: string, env: NodeJS.ProcessEnv = noTokenEnv()) {
  const r = spawnSync("node", [CLI, ...args], { encoding: "utf8", cwd, env });
  return { code: r.status, all: (r.stdout ?? "") + (r.stderr ?? "") };
}

function tmpWork() {
  return mkdtempSync(join(tmpdir(), "rec-dryrun-work-"));
}

const okScenario = (name: string) => `name: ${name}\nprompt: "do the thing"\nfidelity: protocol\nassert:\n  - result: success\n`;
const brokenScenario = "prompt: 123\n"; // wrong type — fails Zod validation → classified `broken`, not `skipped`

describe.skipIf(!can)("record --dry-run — token/agent lines no longer read as a failure", () => {
  it("single scenario: absent token is worded as an informational preview, not a bare ✗ MISSING", () => {
    const work = tmpWork();
    writeFileSync(join(work, "s.yaml"), okScenario("s"));
    const r = cli(["record", join(work, "s.yaml"), "--dry-run"], work);
    expect(r.code).toBe(0);
    // the OLD alarming wording must be gone…
    expect(r.all).not.toMatch(/✗ MISSING/);
    // …and the new wording explicitly says it's fine for --dry-run, so a CI-log reader can tell at a
    // glance nothing failed.
    expect(r.all).toMatch(/token:\s+\(absent[^)]*fine for --dry-run/);
  });

  it("directory batch: same wording fix applies to the batch preview", () => {
    const work = tmpWork();
    writeFileSync(join(work, "s.yaml"), okScenario("s"));
    const r = cli(["record", work, "--dry-run"], work);
    expect(r.code).toBe(0);
    expect(r.all).not.toMatch(/✗ MISSING/);
    expect(r.all).toMatch(/token:\s+\(absent[^)]*fine for --dry-run/);
  });

  it("neither the token nor the agent line is ever ✗-prefixed under --dry-run (the failure marker is reserved for ✗ broken:)", () => {
    const work = tmpWork();
    writeFileSync(join(work, "s.yaml"), okScenario("s"));
    const r = cli(["record", join(work, "s.yaml"), "--dry-run"], work);
    expect(r.all).not.toMatch(/token:\s*✗/);
    expect(r.all).not.toMatch(/agent:\s*✗/);
  });
});

describe.skipIf(!can)("record --dry-run --quiet — suppresses the preview block only", () => {
  it("single scenario: --quiet suppresses the whole preview (no header, no token/agent lines), exit code unchanged", () => {
    const work = tmpWork();
    writeFileSync(join(work, "s.yaml"), okScenario("s"));
    const loud = cli(["record", join(work, "s.yaml"), "--dry-run"], work);
    const quiet = cli(["record", join(work, "s.yaml"), "--dry-run", "--quiet"], work);
    expect(loud.code).toBe(0);
    expect(quiet.code).toBe(loud.code);
    expect(quiet.all).not.toMatch(/record --dry-run/);
    expect(quiet.all).not.toMatch(/token:/);
    expect(quiet.all).not.toMatch(/agent:/);
    expect(quiet.all.trim()).toBe("");
  });

  it("directory batch (no broken files): --quiet suppresses the scenario list + token/agent lines, exit code unchanged", () => {
    const work = tmpWork();
    writeFileSync(join(work, "s.yaml"), okScenario("s"));
    const loud = cli(["record", work, "--dry-run"], work);
    const quiet = cli(["record", work, "--dry-run", "--quiet"], work);
    expect(loud.code).toBe(0);
    expect(loud.all).toMatch(/scenario\(s\) in/);
    expect(quiet.code).toBe(loud.code);
    expect(quiet.all).not.toMatch(/scenario\(s\) in/);
    expect(quiet.all).not.toMatch(/token:/);
    expect(quiet.all).not.toMatch(/agent:/);
  });

  it("directory batch WITH a broken scenario: --quiet still prints ✗ broken: and still exits 1 — the hard constraint", () => {
    const work = tmpWork();
    writeFileSync(join(work, "bad.yaml"), brokenScenario);
    const loud = cli(["record", work, "--dry-run"], work);
    const quiet = cli(["record", work, "--dry-run", "--quiet"], work);
    expect(loud.code).toBe(1);
    expect(loud.all).toMatch(/✗ broken:/);
    expect(quiet.code).toBe(1); // exit code must be IDENTICAL with/without --quiet
    expect(quiet.all).toMatch(/✗ broken:/); // the loader check's only useful output — never muted
  });

  it("directory batch WITH a valid scenario AND a broken one: --quiet keeps ✗ broken: but drops the preview lines, same exit code", () => {
    const work = tmpWork();
    writeFileSync(join(work, "ok.yaml"), okScenario("ok"));
    writeFileSync(join(work, "bad.yaml"), brokenScenario);
    const loud = cli(["record", work, "--dry-run"], work);
    const quiet = cli(["record", work, "--dry-run", "--quiet"], work);
    expect(quiet.code).toBe(loud.code); // both broken-present branches exit 1
    expect(quiet.all).toMatch(/✗ broken:/);
    expect(quiet.all).not.toMatch(/scenario\(s\) in/);
    expect(quiet.all).not.toMatch(/token:/);
  });

  it("empty directory (nothing discovered, no broken files): --quiet does not change the exit-2 outcome", () => {
    const work = tmpWork();
    mkdirSync(join(work, "empty"));
    const loud = cli(["record", join(work, "empty"), "--dry-run"], work);
    const quiet = cli(["record", join(work, "empty"), "--dry-run", "--quiet"], work);
    expect(loud.code).toBe(2);
    expect(quiet.code).toBe(2);
  });

  it("-q is accepted as the --quiet alias for record --dry-run", () => {
    const work = tmpWork();
    writeFileSync(join(work, "s.yaml"), okScenario("s"));
    const r = cli(["record", join(work, "s.yaml"), "--dry-run", "-q"], work);
    expect(r.code).toBe(0);
    expect(r.all.trim()).toBe("");
  });
});
