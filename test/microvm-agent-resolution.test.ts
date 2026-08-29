import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * microvm used to derive the agent ELF path itself (`agentBinary.stagedPath`, raw) instead of going
 * through `resolveAgentBinary` like every other executed-agent tier. Three safeguards were missing as a
 * result — the pruned-binary fallback, the existence check that yields an actionable error, and the sha
 * verification — and the symptom was `env: 'claude': No such file or directory`, exit 127, naming nothing.
 *
 * These are STRUCTURAL assertions on the call graph rather than behavioural ones: booting a real VZ VM in
 * a unit test is not available, so what is pinned is that the derivation stays single-sourced. A
 * behavioural test would need a microvm run (see the live lane).
 */
const lima = readFileSync(join(import.meta.dirname, "..", "src", "runtime", "lima.ts"), "utf8");

describe("microvm agent-binary resolution goes through the shared resolver", () => {
  it("lima.ts imports resolveAgentBinary", () => {
    expect(lima).toMatch(/import \{ resolveAgentBinary \} from "\.\.\/baseline\.js";/);
  });

  // The regression itself: a second, unguarded derivation of the pinned path. `stagedHostOf` may read
  // `agentBinary.stagedPath` only as the read-only fallback, never as the value handed to the VM.
  it("the VM boot path resolves strictly rather than reading the pinned path raw", () => {
    expect(lima).toMatch(/const stagedHost = stagedHostOf\(baseline, \{ strict: true \}\)/);
  });

  // microvm EXECUTES this ELF. `parityMount` is the tolerance for hostloop's non-executed bind mount;
  // taking it here would re-open the sha hole this fix closes.
  it("does NOT take the parityMount tolerance — microvm runs the binary", () => {
    expect(lima).not.toMatch(/resolveAgentBinary\([^)]*parityMount/);
  });

  // `vm status` / `vm prune` / `doctor` are what an operator reaches for WHEN the binary is missing.
  // They must still produce an instance name instead of throwing.
  it("keeps a non-throwing path for the read-only callers", () => {
    expect(lima).toMatch(/catch \{\s*\n\s*return raw;/);
  });

  // The subtlety that made the first attempt at this fix miss the REPORTED case: `vmInit` returns early
  // when the instance is already Running. A VM created while the binary was present keeps a mount at that
  // host path, so a later prune leaves a Running instance whose mount resolves to nothing — and the
  // original bug report was exactly that state. Resolution must therefore happen BEFORE the reuse
  // short-circuit, so every spawn re-checks rather than only the create path.
  it("resolves BEFORE the Running short-circuit, so a reused VM is re-checked", () => {
    const body = lima.slice(lima.indexOf("export function vmInit"));
    const resolvedAt = body.indexOf("stagedHostOf(baseline, { strict: true })");
    const shortCircuitAt = body.indexOf('if (status === "Running") return');
    expect(resolvedAt).toBeGreaterThan(-1);
    expect(shortCircuitAt).toBeGreaterThan(-1);
    expect(resolvedAt).toBeLessThan(shortCircuitAt);
  });
});
