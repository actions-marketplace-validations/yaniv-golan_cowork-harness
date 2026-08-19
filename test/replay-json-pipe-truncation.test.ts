import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, copyFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// Regression: `replay … --output-format json` piped to a consumer must not truncate at the 64KB pipe
// buffer. The bug: the machine-output emitter used `process.stdout.write` (async on a pipe) followed by
// `process.exit()`, which tears down the process before the buffered tail drains — silently dropping
// everything past ~65536 bytes. Invisible to a file redirect, fatal to any `| jq` / `subprocess.run`.
// `spawnSync` captures via a pipe, so it is a faithful child-side repro (the discarded remainder is lost
// at exit regardless of how fast the parent drains).
//
// We build a >64KB envelope by replaying a DIRECTORY of N copies of an existing cassette — `replay <dir>`
// emits ONE combined JSON envelope (results array), so N copies scale a single JSON line past the buffer.
const CLI = resolve("dist/cli.js");
const REPO = resolve(".");
const can = existsSync(CLI);

// A committed cassette to multiply (`cassettes/` is gitignored, so use examples/).
//
// N is DERIVED, not hard-coded. It used to be a literal 10 justified as "~15KB/result", but the real
// figure was ~5.5KB — so the margin was fiction and the total sat just under 65536. A routine re-record
// of the seed (1.32885.1: 39.3KB → 34.5KB) then tipped it under and the suite went red for a reason
// that has nothing to do with the truncation bug this file exists to pin. Measuring one result and
// sizing N from it cannot rot that way. The `> 65536` assertion below still stands as the tripwire.
const SEED = join(REPO, "examples", "replays", "example-multiselect-gate.cassette.json");
const seedExists = existsSync(SEED);
const PIPE_BUF = 65536;

describe.skipIf(!can || !seedExists)("replay --output-format json is not truncated on a pipe", () => {
  it("emits a complete, parseable envelope exceeding the 64KB pipe buffer", () => {
    // Measure one result, then take ~2x the pipe buffer so the margin is real whatever the seed weighs.
    const probe = spawnSync("node", [CLI, "replay", SEED, "--output-format", "json"], {
      encoding: "utf8",
      cwd: REPO,
      maxBuffer: 16 << 20,
    });
    const perResult = (probe.stdout ?? "").length;
    expect(perResult).toBeGreaterThan(0); // a broken probe must fail loudly, not silently pick N=1
    const N = Math.max(4, Math.ceil((2 * PIPE_BUF) / perResult));

    const dir = mkdtempSync(join(tmpdir(), "cc-replay-big-"));
    for (let i = 0; i < N; i++) {
      copyFileSync(SEED, join(dir, `copy-${String(i).padStart(3, "0")}.cassette.json`));
    }
    expect(readdirSync(dir).length).toBe(N);

    const r = spawnSync("node", [CLI, "replay", dir, "--output-format", "json"], {
      encoding: "utf8",
      cwd: REPO,
      maxBuffer: 16 << 20, // 16MB — never the limiter; the bug is the child dropping bytes, not the parent buffer
    });

    const out = r.stdout ?? "";
    // 1) It must exceed the pipe buffer (else the fixture shrank and the test proves nothing).
    expect(out.length).toBeGreaterThan(65536);
    // 2) It must be complete, valid JSON (truncation yields an unterminated string → parse throws).
    const parsed = JSON.parse(out);
    // 3) Sanity: the combined envelope carries all N results.
    expect(Array.isArray(parsed.results)).toBe(true);
    expect(parsed.results.length).toBe(N);
  });
});
