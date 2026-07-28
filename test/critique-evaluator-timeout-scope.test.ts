import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runCritique } from "../src/critique/evaluator.js";
import type { EvidenceSection } from "../src/critique/armor.js";

// The evaluator raises the shared transport's timeout for its own passes (a 600s decider default is sized
// for a one-line gate, not a large-corpus grading pass, and it is a SIGKILL with no retry). The raise must
// be SCOPED: a leak applies it to every later decider gate in the process and to child processes.

const SECTIONS: EvidenceSection[] = [{ title: "T", body: "b" }];
const ENV = "COWORK_HARNESS_LLM_TIMEOUT_MS";
const REPLY = JSON.stringify({ items: [{ idea: "CANARY-OK", classification: "not-adjudicable", evidence: "", recommendedAction: "" }] });

let saved: string | undefined;
beforeEach(() => {
  saved = process.env[ENV];
  delete process.env[ENV];
});
afterEach(() => {
  if (saved === undefined) delete process.env[ENV];
  else process.env[ENV] = saved;
});

/** A transport that reports the timeout visible DURING its call, then resolves on demand. */
function gatedComplete() {
  const seen: Array<string | undefined> = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  return {
    seen,
    release,
    complete: async () => {
      seen.push(process.env[ENV]);
      await gate;
      return { text: REPLY, model: "m", usage: {} };
    },
  };
}

describe("evaluator transport-timeout scope", () => {
  it("restores an unset env after a single critique", async () => {
    const g = gatedComplete();
    const p = runCritique(SECTIONS, undefined, { complete: g.complete, nonce: "n" });
    g.release();
    await p;
    expect(process.env[ENV]).toBeUndefined();
  });

  it("never leaks, and never drops, across INTERLEAVED critiques", async () => {
    // Regression: the scope tested the env before its own depth, so the second call read the value the
    // first had just written, declined to join the scope, and was left at the 600s default the instant the
    // first call finished — and the last finisher then restored the RAISED value permanently.
    const a = gatedComplete();
    const b = gatedComplete();
    const pa = runCritique(SECTIONS, undefined, { complete: a.complete, nonce: "n" });
    const pb = runCritique(SECTIONS, undefined, { complete: b.complete, nonce: "n" });
    a.release();
    await pa;
    // B is still in flight: it must STILL see the raised timeout.
    expect(process.env[ENV]).toBe("1800000");
    b.release();
    await pb;
    expect(process.env[ENV]).toBeUndefined(); // and nothing leaks once the last one leaves
  });

  it("never overrides a timeout the operator set", async () => {
    process.env[ENV] = "12345";
    const g = gatedComplete();
    const p = runCritique(SECTIONS, undefined, { complete: g.complete, nonce: "n" });
    g.release();
    await p;
    expect(g.seen[0]).toBe("12345");
    expect(process.env[ENV]).toBe("12345");
  });
});
