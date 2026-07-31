import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { extname } from "node:path";

// Repo hygiene: no tracked TEXT file may contain a literal NUL (0x00) byte.
//
// This exists because of a real defect with a silent failure mode. `src/run/run-index.ts` carried one
// stray 0x00 — a doc comment that wrote an actual NUL while *describing* NUL injection, instead of the
// `\0` escape the code beside it uses. One byte was enough for `file` to classify the whole module as
// `data`, and grep SKIPS binary files: `grep -c "index.jsonl" src/run/run-index.ts` returned 0 while awk
// found 5. Every grep-based audit had been passing over the file that defines the run index and
// `RunIndexRow` — reporting nothing rather than reporting a skip.
//
// That asymmetry is the whole argument for this test. A NUL byte does not fail a build, break a type, or
// produce a wrong answer; it makes a file quietly invisible to the tooling everyone reaches for first. It
// is exactly the class of defect that survives review, so it gets a machine check instead.
//
// Scans the GIT-TRACKED set (so it never wanders into node_modules/, dist/, or a sibling worktree), minus
// the extensions that legitimately hold binary content. A new binary asset type is expected to FAIL here
// first and be added deliberately — a silent extension-sniffing widen is how a guard stops guarding.

/** Extensions whose tracked files legitimately contain NUL bytes. Today: `docs/assets/banner.png` is the
 *  only tracked binary at all. Add to this list only for a genuine binary asset — never to silence a
 *  source/doc file, which is the case this test exists to catch. */
const BINARY_EXTENSIONS = new Set([".png", ".pdf"]);

function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z"], { encoding: "buffer", maxBuffer: 32 * 1024 * 1024 })
    .toString("utf8")
    .split("\0")
    .filter((p) => p.length > 0);
}

/** 1-based line number of the first NUL, for a message that points at the edit rather than the file. */
function firstNulLine(buf: Buffer): number {
  const at = buf.indexOf(0);
  let line = 1;
  for (let i = 0; i < at; i++) if (buf[i] === 0x0a) line++;
  return line;
}

describe("tracked text files carry no NUL bytes", () => {
  it("finds no 0x00 in any tracked non-binary file", () => {
    const offenders: string[] = [];
    for (const path of trackedFiles()) {
      if (BINARY_EXTENSIONS.has(extname(path).toLowerCase())) continue;
      let buf: Buffer;
      try {
        buf = readFileSync(path);
      } catch {
        continue; // a tracked-but-absent path (sparse checkout) is not this test's business
      }
      if (buf.includes(0)) offenders.push(`${path}:${firstNulLine(buf)}`);
    }
    expect(
      offenders,
      offenders.length === 0
        ? ""
        : `NUL (0x00) byte in tracked text file(s):\n  ${offenders.join("\n  ")}\n\n` +
            `grep SKIPS files containing a NUL — it reports no matches rather than reporting a skip, so ` +
            `every grep-based audit silently loses the file. If a control byte is being DESCRIBED, write ` +
            `the escape (\\0, \\x00) instead of embedding it. If this is a genuine binary asset, add its ` +
            `extension to BINARY_EXTENSIONS in this test.`,
    ).toEqual([]);
  });

  it("scans a plausible number of files (guards against an empty tracked set silently passing)", () => {
    // A `git ls-files` that returns nothing — wrong cwd, git absent, a broken invocation — would make the
    // check above pass vacuously. Assert the corpus is real rather than trusting it.
    expect(trackedFiles().length).toBeGreaterThan(100);
  });
});
