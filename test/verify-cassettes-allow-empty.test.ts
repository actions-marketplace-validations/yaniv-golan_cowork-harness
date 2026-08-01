import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// `verify-cassettes --allow-empty` — an opt-in for a repo that deliberately commits no cassettes, where
// the default loud exit-2 forces every caller to wrap the command in an `ls` guard (a consumer reported
// exactly that workaround). Exercised through the built CLI, because the whole behaviour under test IS
// the exit code.
//
// The load-bearing test here is the LAST one: `resolveInputs` reports "path not found" and "directory
// exists but is empty" with the same `{error}` shape, and the caller's single `"error" in resolved`
// branch could not tell them apart. Honoring the flag for both would exit 0 on a typo'd or moved path —
// the exact vacuous pass the loud default exists to prevent, for the scripted-CI caller the flag is FOR.
const CLI = resolve("dist/cli.js");
const can = existsSync(CLI);

function run(args: string[]): { code: number; out: string } {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8" });
  return { code: r.status ?? -1, out: (r.stdout ?? "") + (r.stderr ?? "") };
}
function emptyDir(): string {
  const d = mkdtempSync(join(tmpdir(), "cc-allow-empty-"));
  mkdirSync(join(d, "cassettes"));
  return join(d, "cassettes");
}

describe.skipIf(!can)("verify-cassettes --allow-empty", () => {
  it("without the flag, an empty directory is a loud usage error (exit 2) — the default is unchanged", () => {
    const r = run(["verify-cassettes", emptyDir()]);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/nothing to do/);
  });

  it("with the flag, an EXISTING but cassette-free directory exits 0", () => {
    const r = run(["verify-cassettes", emptyDir(), "--allow-empty"]);
    expect(r.code).toBe(0);
  });

  it("the JSON envelope is a well-formed clean result (ok:true, empty results), not a skipped run", () => {
    const r = run(["verify-cassettes", emptyDir(), "--allow-empty", "--output-format", "json"]);
    expect(r.code).toBe(0);
    const env = JSON.parse(r.out.trim());
    expect(env).toMatchObject({ command: "verify-cassettes", ok: true, results: [] });
    // coverage still reports which scans WOULD have run — an empty result set must not read as
    // "privacy/staleness were skipped", which is a different and worse claim.
    expect(env.coverage).toEqual({ privacy: true, staleness: true });
  });

  // THE REGRESSION THIS FLAG COULD HAVE INTRODUCED.
  it("still fails loudly on a MISSING path, even with --allow-empty — the flag can never green a typo", () => {
    const missing = join(tmpdir(), "cc-allow-empty-does-not-exist-9d3f1");
    expect(existsSync(missing)).toBe(false);
    const r = run(["verify-cassettes", missing, "--allow-empty"]);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/path not found/);
  });
});
