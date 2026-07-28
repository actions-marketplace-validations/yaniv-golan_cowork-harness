import { describe, it, expect, beforeEach, vi } from "vitest";

// writeAllSync (src/io.ts) replaces the bare `writeSync(fd, s + "\n")` idiom used across the CLI's
// stdout/stderr sinks. Two defects it fixes, each needing a controlled fake `writeSync` to exercise:
//
//   1. Short writes: `writeSync` can return fewer bytes than requested (common on a pipe). A naive fix
//      that re-slices the source *string* by the returned byte count corrupts multi-byte UTF-8
//      characters split across a chunk boundary — so the fixture below chunks in a byte count (3) that
//      does NOT line up with any character boundary in the multi-byte payload, and the assertion checks
//      byte-for-byte equality against a `Buffer`, not just "the string looks right".
//   2. EAGAIN: a full pipe with a slow reader makes `writeSync` throw instead of blocking. writeAllSync
//      must retry with backoff — and must NOT retry forever once the pipe never clears.
//
// `node:fs`'s `writeSync` is mocked (real fs otherwise) so these failure modes are reproducible without
// an actual OS pipe.
const state = vi.hoisted(() => ({
  mode: "shortWrite" as "shortWrite" | "eagainThenOk" | "eagainForever",
  chunkSize: 3,
  eagainRemaining: 0,
  written: [] as Buffer[],
}));

function eagainError(): NodeJS.ErrnoException {
  const err = new Error("EAGAIN: resource temporarily unavailable, write") as NodeJS.ErrnoException;
  err.code = "EAGAIN";
  return err;
}

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    writeSync: (_fd: number, buffer: unknown, offset?: number): number => {
      const buf = buffer as Buffer;
      const off = offset ?? 0;

      if (state.mode === "eagainForever") throw eagainError();

      if (state.mode === "eagainThenOk") {
        if (state.eagainRemaining > 0) {
          state.eagainRemaining--;
          throw eagainError();
        }
        const n = buf.length - off;
        state.written.push(Buffer.from(buf.subarray(off, off + n)));
        return n;
      }

      // shortWrite: never accept more than `chunkSize` bytes per call, so a multi-byte character can
      // land split across two writeSync calls — exactly the case a string-slicing "fix" would corrupt.
      const remaining = buf.length - off;
      const n = Math.max(1, Math.min(state.chunkSize, remaining));
      state.written.push(Buffer.from(buf.subarray(off, off + n)));
      return n;
    },
  };
});

const { writeAllSync } = await import("../src/io.js");

beforeEach(() => {
  state.mode = "shortWrite";
  state.chunkSize = 3;
  state.eagainRemaining = 0;
  state.written = [];
});

describe("writeAllSync — short writes", () => {
  it("reassembles a byte-exact payload when writeSync only accepts a few bytes per call, including multi-byte UTF-8", () => {
    state.chunkSize = 3; // deliberately not aligned to any UTF-8 character boundary
    const payload = "— hello … world ✓ — 日本語 — ".repeat(20);
    const expected = Buffer.from(payload, "utf8");
    // Sanity: a genuinely multi-byte payload, and small enough chunks that at least one character
    // must straddle a chunk boundary (else the test proves nothing about corruption).
    expect(expected.length).toBeGreaterThan(payload.length);

    writeAllSync(1, payload);

    const result = Buffer.concat(state.written);
    expect(result.equals(expected)).toBe(true);
    expect(result.toString("utf8")).toBe(payload);
  });

  it("delivers the full payload for plain ASCII short writes too", () => {
    state.chunkSize = 1; // one byte per writeSync call — maximally short
    const payload = "line one\nline two\n";
    writeAllSync(1, payload);
    expect(Buffer.concat(state.written).toString("utf8")).toBe(payload);
  });
});

describe("writeAllSync — EAGAIN retry", () => {
  it("retries through repeated EAGAIN and delivers the full payload once the pipe clears", () => {
    state.mode = "eagainThenOk";
    state.eagainRemaining = 5; // throws EAGAIN 5 times, succeeds on the 6th attempt
    const payload = "hello world\n";
    writeAllSync(1, payload);
    expect(state.eagainRemaining).toBe(0); // proves the retries actually happened
    expect(Buffer.concat(state.written).toString("utf8")).toBe(payload);
  });

  it("throws rather than hanging forever when EAGAIN never clears", () => {
    state.mode = "eagainForever";
    const start = Date.now();
    expect(() => writeAllSync(1, "stuck\n")).toThrowError(/EAGAIN/);
    const elapsed = Date.now() - start;
    // Bounded retry budget: must give up well short of the test timeout, proving it isn't a busy-loop
    // or an unbounded wait — a few seconds at most, not tens of seconds and not instantaneous (which
    // would suggest it gave up without retrying at all).
    expect(elapsed).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(8000);
    expect(state.written.length).toBe(0);
  }, 10000);
});
