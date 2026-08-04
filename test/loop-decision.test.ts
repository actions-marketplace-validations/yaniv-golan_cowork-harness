import { describe, it, expect } from "vitest";
import { decideLoop, decideLoopFromBaseline, readGateBool, readGateFlag, resolveSkillDiscoveryGates } from "../src/loop-decision.js";
import { loadBaseline } from "../src/baseline.js";
import type { PlatformBaseline } from "../src/types.js";

// Mirrors Cowork's f_() exactly (asar 1.12603.1).
describe("loop decision (f_ replica)", () => {
  it("requireFullVmSandbox forces VM-loop (HeA)", () => {
    expect(decideLoop({ requireFullVmSandbox: true, gateHostLoopOn: true })).toBe("vm");
  });
  it("dev override forces host-loop", () => {
    expect(decideLoop({ devForceHostLoop: true, gateHostLoopOn: false })).toBe("host");
  });
  it("otherwise follows the gate", () => {
    expect(decideLoop({ gateHostLoopOn: true })).toBe("host");
    expect(decideLoop({ gateHostLoopOn: false })).toBe("vm");
  });
  it("policy beats the gate (precedence order)", () => {
    expect(decideLoop({ requireFullVmSandbox: true, devForceHostLoop: true, gateHostLoopOn: true })).toBe("vm");
  });
});

describe("decideLoopFromBaseline — reads requireFullVmSandbox from the baseline (bug fix)", () => {
  const withGate = (gate: string, extra: Record<string, unknown> = {}) =>
    ({ provenance: { gates: { "hostLoop:1143815894": gate } }, ...extra }) as any;
  it("host-loop when the gate is on(force) and no org lockdown", () => {
    expect(decideLoopFromBaseline(withGate("on(force)"))).toBe("host");
  });
  it("a locked-down org baseline (requireFullVmSandbox:true) forces VM-loop even with the gate on", () => {
    expect(decideLoopFromBaseline(withGate("on(force)", { requireFullVmSandbox: true }))).toBe("vm");
  });
  // post-sync gates are STRUCTURED entries ({on,source,value}), not prose strings. Reading `.on`
  // (not a bare `!!obj`, which is truthy even for an off gate) is what makes an off gate force VM-loop.
  it("reads a synced structured gate entry: {on:true} → host, {on:false} → vm", () => {
    const structured = (on: boolean) => ({ provenance: { gates: { "hostLoop:1143815894": { on, source: "force", value: on } } } }) as any;
    expect(decideLoopFromBaseline(structured(true))).toBe("host");
    expect(decideLoopFromBaseline(structured(false))).toBe("vm"); // a bare !!obj would wrongly yield host here
  });

  // /on|true|force/i matched "off(force)" via the substring "force", wrongly deciding host-loop.
  it("off(force) gate string -> vm-loop (substring 'force' must not match)", () => {
    expect(decideLoopFromBaseline(withGate("off(force)"))).toBe("vm");
  });
});

// --- A2 skills/plugins discovery gates -------------------------------------------------------
// These gates are BARE-BOOLEAN (truth in the top-level `.on`), unlike `readGateFlag`'s
// object-of-named-sub-flags shape. Using the wrong reader returns `false` for the ON gate and
// silently strips `suggest_skills` from every cowork-lane run — a default INVERSION that the
// handler tests cannot catch (they take booleans in directly, so they test the gate's EFFECT,
// never its DERIVATION). The pins below are that missing derivation guard.
describe("readGateBool / resolveSkillDiscoveryGates (A2 discovery gates)", () => {
  const LIVE = loadBaseline("desktop-1.24012.1");
  const gated = (gates: Record<string, unknown>) => ({ provenance: { gates } }) as unknown as PlatformBaseline;

  it("reads the top-level .on of a prefixed bare-boolean gate", () => {
    expect(readGateBool(LIVE, "245679952")).toBe(true); // suggestSkillsEnabled -> {on:true,source:"force"}
    expect(readGateBool(LIVE, "1598976391")).toBe(false); // proactiveSkillSuggestEnabled -> {on:false}
  });
  it("finds the gate by BARE id too (not only the `name:id` prefixed key)", () => {
    expect(readGateBool(gated({ "245679952": { on: true } }), "245679952")).toBe(true);
  });
  it("returns undefined — not false — when the gate is absent, so the caller's default survives", () => {
    expect(readGateBool(gated({}), "245679952")).toBeUndefined();
    // A baseline that predates the gates entirely: both absent.
    expect(readGateBool(loadBaseline("desktop-1.22209.3"), "245679952")).toBeUndefined();
  });
  it("returns undefined for an object entry carrying no boolean .on (a false would defeat the default)", () => {
    expect(readGateBool(gated({ "245679952": { value: true } }), "245679952")).toBeUndefined();
    expect(readGateBool(gated({ "245679952": { state: "on" } }), "245679952")).toBeUndefined();
  });

  // THE inversion pin: if readGateBool were swapped for readGateFlag(baseline, id, "suggestSkillsEnabled")
  // this returns false, and suggest_skills silently disappears from every container/hostloop run.
  it("resolves suggestSkillsEnabled TRUE against the live baseline (kills the readGateFlag inversion)", () => {
    expect(readGateFlag(LIVE, "245679952", "suggestSkillsEnabled")).toBe(false); // the WRONG reader's answer
    expect(resolveSkillDiscoveryGates(LIVE).suggestSkillsEnabled).toBe(true); // the RIGHT one
  });

  it("precedence: explicit session knob beats the gate, in both directions", () => {
    expect(resolveSkillDiscoveryGates(LIVE, { suggest_enabled: false }).suggestSkillsEnabled).toBe(false);
    expect(resolveSkillDiscoveryGates(LIVE, { proactive_suggest_enabled: true }).proactiveSkillSuggestEnabled).toBe(true);
  });
  it("precedence: gate beats the documented default", () => {
    const off = gated({ "suggestSkillsEnabled:245679952": { on: false }, "proactiveSkillSuggestEnabled:1598976391": { on: true } });
    expect(resolveSkillDiscoveryGates(off)).toEqual({ suggestSkillsEnabled: false, proactiveSkillSuggestEnabled: true });
  });
  it("falls back to the documented defaults (suggest ON, proactive OFF) when both gates are absent", () => {
    expect(resolveSkillDiscoveryGates(gated({}))).toEqual({ suggestSkillsEnabled: true, proactiveSkillSuggestEnabled: false });
  });
  it("an undefined knob does not shadow the gate (?? not ||)", () => {
    expect(resolveSkillDiscoveryGates(LIVE, { suggest_enabled: undefined }).suggestSkillsEnabled).toBe(true);
  });
  // Symmetric pin for the proactive line: an explicit `false` knob must WIN over an ON gate. Without
  // this, `??` -> `||` survives on that line. It uses a SYNTHETIC baseline deliberately: `LIVE` is pinned
  // to desktop-1.24012.1, where the gate is off, so this asymmetry would be invisible there. (From the
  // 1.24012.11 baseline the gate IS on, so `latest` would now exercise it — but pinning the synthetic
  // keeps the guard independent of which baseline happens to be newest.)
  it("an explicit false knob beats an ON gate on the proactive line too (?? not ||)", () => {
    const on = gated({ "1598976391": { on: true } });
    expect(resolveSkillDiscoveryGates(on).proactiveSkillSuggestEnabled).toBe(true);
    expect(resolveSkillDiscoveryGates(on, { proactive_suggest_enabled: false }).proactiveSkillSuggestEnabled).toBe(false);
  });
});
