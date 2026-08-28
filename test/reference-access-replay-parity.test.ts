import { describe, it, expect } from "vitest";
import { replayCassette, ALWAYS_CONTENT_KEYS, LIVE_ONLY_KEYS, MANIFEST_KEYS, QUESTION_GATE_KEYS } from "../src/run/cassette";

// Replay is a first-class lane for this signal, not a cannot-verify one: cassettes freeze WHOLE tool
// inputs, so the replay re-drive reconstructs every channel from the same events the live run saw. The
// original version of this file "proved" that by calling one pure function twice over one array — which
// could only fail if the helper grew module-level state, and could not see whether replay calls the
// capture at all, whether a cassette preserves `command`, or whether the persisted field is right. It was
// theatre. These drive a real cassette instead.

const REF = "/sessions/local_x/mnt/.local-plugins/cache/my-plugin/references/env.md";

function cassetteWith(assertions: Record<string, unknown>[], events: string[], controlOut: string[] = []): any {
  return {
    scenario: {
      name: "ref-access",
      baseline: "latest",
      session: "(inline)",
      fidelity: "container",
      prompt: "hi",
      answers: [],
      expect_denied: [],
      assert: assertions,
    },
    events,
    controlOut,
  };
}

const BASH_READ = JSON.stringify({
  type: "assistant",
  message: {
    role: "assistant",
    content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: `cat ${REF}`, description: "read it" } }],
  },
});
const INIT = JSON.stringify({ type: "system", subtype: "init", tools: ["Bash"] });
const DONE = JSON.stringify({ type: "result", subtype: "success", is_error: false });

describe("replay classification", () => {
  it("both keys are replay-evaluated content keys, in no other bucket", () => {
    for (const k of ["reference_read", "no_observed_reference_access"] as const) {
      expect(ALWAYS_CONTENT_KEYS, k).toContain(k);
      expect(LIVE_ONLY_KEYS, k).not.toContain(k);
      expect(MANIFEST_KEYS, k).not.toContain(k);
      expect(QUESTION_GATE_KEYS, k).not.toContain(k);
    }
  });
});

describe("a real replay re-derives reference access from the frozen tool inputs", () => {
  it("populates result.referencesAccessed and PASSES reference_read from a frozen Bash command", async () => {
    const r = await replayCassette(cassetteWith([{ result: "success" }, { reference_read: "env\\.md" }], [INIT, BASH_READ, DONE]));
    expect(r.referencesAccessed).toEqual([{ path: "references/env.md", via: ["bash"] }]);
    expect(r.assertions?.find((a) => JSON.stringify(a.assertion).includes("reference_read"))?.pass).toBe(true);
  });

  it("FAILS no_observed_reference_access on that same cassette — the two keys read one derivation", async () => {
    const r = await replayCassette(
      cassetteWith([{ result: "success" }, { no_observed_reference_access: "env\\.md" }], [INIT, BASH_READ, DONE]),
    );
    expect(r.assertions?.find((a) => JSON.stringify(a.assertion).includes("no_observed"))?.pass).toBe(false);
  });

  it("a cassette with no qualifying access yields [] — a real negative the negative key can pass on", async () => {
    const r = await replayCassette(cassetteWith([{ no_observed_reference_access: "env\\.md" }], [INIT, DONE]));
    expect(r.referencesAccessed).toEqual([]);
    expect(r.assertions?.[0]?.pass).toBe(true);
  });
});

describe("a TRUNCATED cassette must report cannot-verify, not a clean negative", () => {
  // The worst defect an adversarial pass found: `replay` itself said "evidence unavailable" while the
  // result.json it wrote carried `[]`, so `verify-run` and `critique` reading that same file reported a
  // clean negative — for a run whose frozen events contained the read. The contract has to hold where it
  // is written to disk, not only in memory.
  const QUESTION = JSON.stringify({
    type: "control_request",
    request_id: "q1",
    request: {
      subtype: "can_use_tool",
      tool_name: "AskUserQuestion",
      input: { questions: [{ question: "Which format?", options: [{ label: "Markdown" }, { label: "PDF" }] }] },
    },
  });
  const INIT_Q = JSON.stringify({ type: "system", subtype: "init", tools: ["Bash", "AskUserQuestion"] });

  it("persists referencesAccessed as undefined when the cassette could never be driven", async () => {
    // controlOut must be NON-empty: with none at all the gate keys are skipped wholesale and the drive
    // completes, so the truncated branch is never reached. One unrelated response is enough.
    const OTHER = JSON.stringify({
      type: "control_response",
      response: { request_id: "other", subtype: "success", response: { behavior: "allow" } },
    });
    const r = await replayCassette(cassetteWith([{ result: "success" }], [INIT_Q, BASH_READ, QUESTION], [OTHER]));
    expect(r.assertions?.some((a) => /truncated cassette/.test(a.message ?? ""))).toBe(true);
    // The frozen events DID contain a read of this file. Persisting `[]` here made replay say "evidence
    // unavailable" while verify-run and critique, reading the result.json replay had just written,
    // reported a clean negative for that same run.
    expect(r.referencesAccessed).toBeUndefined();
  });
});
