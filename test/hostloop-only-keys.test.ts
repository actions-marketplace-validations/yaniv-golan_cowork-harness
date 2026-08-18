import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { HOSTLOOP_ONLY_KEYS } from "../src/assert.js";
import { hostInventoryPreflight } from "../src/run/cassette.js";
import { Assertion, type Scenario } from "../src/types.js";

// `HOSTLOOP_ONLY_KEYS` exists for ONE outside caller: the host-inventory record refusal, which must not
// tell a scenario to "record at container fidelity" when that scenario asserts a key container can never
// evaluate. The previous advice in that message was a hand-written branch, and it rotted — it recommended
// `--out` outside the repo, which bakes a permanently unverifiable cassette. A second hand-written list
// would rot the same way, so this guard pins the exported set to the evaluator's ACTUAL gate sites by
// scanning the source: the only place `hostloopOnly("…")` is called.
describe("HOSTLOOP_ONLY_KEYS is the evaluator's real gate set", () => {
  const src = readFileSync(resolve("src/assert.ts"), "utf8");
  const gated = [...src.matchAll(/hostloopOnly\("([a-z_]+)"\)/g)].map((m) => m[1]);

  it("found the call sites at all (guards against a refactor that renames the helper)", () => {
    expect(gated.length).toBeGreaterThan(0);
  });

  // BOTH directions. A key gated but unlisted → the refusal sends its author to a tier that cannot run it.
  // A key listed but ungated → the refusal withholds the container advice from someone who could use it.
  it("equals the set of keys passed to hostloopOnly() in src/assert.ts", () => {
    expect([...new Set(gated)].sort()).toEqual([...HOSTLOOP_ONLY_KEYS].sort());
  });

  it("every listed key is a real Assertion key", () => {
    const real = Object.keys(Assertion.shape);
    expect(HOSTLOOP_ONLY_KEYS.filter((k) => !real.includes(k))).toEqual([]);
  });
});

// The behaviour the set drives. `hostInventoryPreflight` refuses a host-inheriting record into a
// repo-visible path; what differs per scenario is the REMEDY it names.
describe("the host-inventory refusal names a remedy the scenario can actually take", () => {
  const scenario = (assert: unknown[]): Scenario =>
    ({ name: "s", prompt: "p", session: "sessions/default.yaml", fidelity: "hostloop", assert }) as unknown as Scenario;
  // A repo-visible path that does not exist yet → the refuse branch (an existing fixture only warns).
  const refuse = (s: Scenario) => hostInventoryPreflight(s, resolve("examples/replays/does-not-exist.cassette.json"), false);

  it("offers container fidelity to a scenario with no hostloop-only key", () => {
    const v = refuse(scenario([{ result: "success" }]));
    expect(v.kind).toBe("refuse");
    if (v.kind !== "refuse") return;
    expect(v.message).toMatch(/record at 'container' fidelity/);
    expect(v.message).not.toMatch(/only evaluate at hostloop/);
  });

  it("does NOT offer container to a scenario asserting a hostloop-only key — it names the key and the override", () => {
    const v = refuse(scenario([{ no_vm_path_file_op: true }]));
    expect(v.kind).toBe("refuse");
    if (v.kind !== "refuse") return;
    expect(v.message).toMatch(/asserts no_vm_path_file_op/);
    expect(v.message).toMatch(/only evaluate at hostloop/);
    expect(v.message).toMatch(/--allow-host-inventory-fixture/);
    // The regression this whole change exists for: never recommend container to a scenario that
    // cannot use it.
    expect(v.message).not.toMatch(/Fix: record at 'container'/);
  });

  it("never recommends --out outside the repo, on either branch", () => {
    for (const s of [scenario([{ result: "success" }]), scenario([{ path_denied: "/sessions/x" }])]) {
      const v = refuse(s);
      expect(v.kind).toBe("refuse");
      if (v.kind !== "refuse") continue;
      // The advice that cost two paid runs. It must be named as NOT a fix, never offered as one.
      expect(v.message).toMatch(/NOT a fix: redirecting --out outside the repo/);
      expect(v.message).not.toMatch(/or --out a path outside the repo/);
      expect(v.message).toMatch(/can't verify ⇒ not green/);
    }
  });
});
