/**
 * `KNOWN_HOOK_EVENTS` vs the agent binary's OWN hooks-config validator array.
 *
 * WHY THIS EXISTS. Until 2026-09-06 the list held 9 names, stamped "ELF 2.1.219", assembled by grepping
 * the binary for event-name constants rather than by finding the validator. It was 24 short, and the
 * consequence was live: `PostCompact` and `MessageDisplay` — both accepted by the agent — were reported
 * to authors byte-identically to a misspelling, at ERROR severity in `lint-skill`. A guard comparing the
 * const against a COMMITTED fixture would not have caught that: both sides are hand-maintained repo
 * files, so it passes forever and only moves when a human re-extracts, which is the step that failed.
 * This reads the staged binary instead.
 *
 * WHAT A GREEN RUN HERE IS WORTH — read this before trusting it. There is no staged Desktop on CI, so
 * this test SKIPS there, permanently. A green CI is not evidence for this invariant; only a local run on
 * a machine with Cowork installed is. That is the same caveat `docs/invariants.md` records for the other
 * Desktop-dependent checks, and it is why the const also carries its provenance in a comment.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { KNOWN_HOOK_EVENTS } from "../src/agent/session.js";

/** `.../claude-code-vm/<ver>/claude`, resolved through the staged `.sdk-version` marker. Returns
 *  undefined when Desktop has never staged an agent here — the CI case. */
function stagedAgentElf(): string | undefined {
  const root = join(homedir(), "Library", "Application Support", "Claude", "claude-code-vm");
  const marker = join(root, ".sdk-version");
  if (!existsSync(marker)) return undefined;
  const ver = readFileSync(marker, "utf8").trim();
  const elf = join(root, ver, "claude");
  return existsSync(elf) ? elf : undefined;
}

/** The validator array, read out of the binary. Anchored on the first four names in the binary's own
 *  order, then sliced to the closing `]`.
 *
 *  THE ANCHOR IS NOT UNIQUE — measured, not assumed. It matches three literals in 2.1.260: the validator
 *  array, a duplicate of it, and the 11-entry cloud-forwarding array that shares the same opening four
 *  names. We take the first by byte offset, which is the validator today. That cannot false-green (an
 *  11-vs-33 comparison fails loudly), but a change in emission order would fail this test for the wrong
 *  reason, so the failure message names the candidates it saw.
 *  Deliberately NOT anchored on a minified symbol: `hy` is a two-build identifier (its sibling gate
 *  accessor renamed FD -> RD between two Desktop patch builds), while the event names are the product's
 *  public surface and move only when the feature does. */
function validatorHookEvents(elf: string): string[] | undefined {
  const anchor = '"PreToolUse","PostToolUse","PostToolUseFailure","PostToolBatch"';
  let out: string;
  try {
    out = execFileSync("/usr/bin/grep", ["-oa", `${anchor}[^]]*`, elf], {
      encoding: "latin1",
      maxBuffer: 1 << 20,
    });
  } catch {
    return undefined; // no match: the array's shape moved — the assertion below reports that as a failure
  }
  // Prefer the longest match rather than the first: all candidates share the anchor, and the validator
  // array is the largest of them. Ordering-independent, so an emission-order change cannot mis-select.
  const lines = out.split("\n").filter((l) => l.length > anchor.length);
  const first = lines.sort((a, b) => b.length - a.length)[0];
  if (!first) return undefined;
  const names = first.match(/"([A-Za-z]+)"/g)?.map((q) => q.slice(1, -1));
  return names && names.length > 4 ? names : undefined;
}

const ELF = stagedAgentElf();

describe("KNOWN_HOOK_EVENTS mirrors the agent's hooks-config validator", () => {
  it.skipIf(!ELF)("equals the validator array in the staged ELF", () => {
    const fromBinary = validatorHookEvents(ELF as string);
    // A missing/!unparseable array is a FAILURE, not a skip: the skip condition is "no binary staged",
    // and conflating the two is how a guard goes quietly blind after a format change.
    expect(fromBinary, `could not read the hook-event array from ${ELF}`).toBeDefined();
    expect([...(fromBinary as string[])].sort()).toEqual([...KNOWN_HOOK_EVENTS].sort());
  });

  // NOT skipIf: these read the const only, so they are the one part of this file CI can enforce.
  it("does not accidentally mirror the 11-entry cloud-forwarding array", () => {
    // `jbr` is a routing set, not a validity list; its complement is mapped across four dispositions.
    // Mirroring it would silently reject 22 valid event names, so pin the distinguishing members.
    expect(KNOWN_HOOK_EVENTS).toContain("MessageDisplay");
    expect(KNOWN_HOOK_EVENTS).toContain("PostCompact");
    expect(KNOWN_HOOK_EVENTS.length).toBe(33);
  });
});
