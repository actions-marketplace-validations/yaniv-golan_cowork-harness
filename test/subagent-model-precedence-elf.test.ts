/**
 * The documented sub-agent model precedence vs. what the agent binary actually does.
 *
 * WHY THIS EXISTS. `docs/session.md`, `docs/subagents.md` and `src/session.ts` all stated the order as
 * `env > dispatch param > frontmatter > inherit`. The binary resolves the opposite way round for the env
 * layer — `tool > frontmatter > env > inherit` — so `agent_env.subagent_model` does NOT outrank a
 * sub-agent's own `model:` frontmatter, which is what two SHIPPED PUBLIC docs promised. Three sites
 * agreeing was not corroboration: they were one unmeasured claim copied twice.
 *
 * Promoting env to the top is exactly what `CLAUDE_CODE_SUBAGENT_MODEL_FORCE` is for (its read site
 * returns the other two unchanged when the flag is unset), and the Cowork spawn sets neither that flag
 * nor `CLAUDE_CODE_COORDINATOR_FORCE_WORKER_INHERIT_MODEL` — so the un-forced order is the one users get.
 *
 * WHAT A GREEN RUN IS WORTH. There is no staged Desktop on CI, so this SKIPS there, permanently. A green
 * CI is not evidence for this invariant; only a local run on a machine with Cowork installed is. Same
 * caveat as `test/hook-events-elf-parity.test.ts` and the spawn-env oracle — see `docs/invariants.md`.
 *
 * WHY IT ANCHORS ON TELEMETRY LABELS. The binary tags the winning layer for its own
 * `subagent_model_resolve` event with the literal strings below. They are product surface, not minified
 * identifiers: the gate accessor beside this very code renamed `FD` -> `RD` between two Desktop patch
 * builds, so a symbol-name anchor would be a release-day wedge. These labels have to stay stable for the
 * telemetry to mean anything.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** The order the repo documents, and the order this test pins. Index 0 wins. */
const EXPECTED_ORDER = ["tool", "frontmatter", "env"] as const;

function stagedAgentElf(): string | undefined {
  const root = join(homedir(), "Library", "Application Support", "Claude", "claude-code-vm");
  const marker = join(root, ".sdk-version");
  if (!existsSync(marker)) return undefined;
  const elf = join(root, readFileSync(marker, "utf8").trim(), "claude");
  return existsSync(elf) ? elf : undefined;
}

/** Byte offsets of a literal, via grep -oba (the file is ~214MB — never read it whole). */
function offsetsOf(elf: string, literal: string): number[] {
  try {
    const out = execFileSync("/usr/bin/grep", ["-oba", literal, elf], { encoding: "latin1", maxBuffer: 1 << 22 });
    return out
      .split("\n")
      .filter(Boolean)
      .map((l) => Number(l.split(":")[0]))
      .filter((n) => Number.isFinite(n));
  } catch {
    return [];
  }
}

function windowAt(elf: string, offset: number, before: number, len: number): string {
  const fd = openSync(elf, "r");
  try {
    const buf = Buffer.alloc(len);
    const n = readSync(fd, buf, 0, len, Math.max(0, offset - before));
    return buf.subarray(0, n).toString("latin1");
  } finally {
    closeSync(fd);
  }
}

/** Candidate windows around `"frontmatter"` that look like a model-resolution chain.
 *
 *  SELECTION IS INDEPENDENT OF THE ANSWER, deliberately — a filter that kept the window whose label order
 *  already matched EXPECTED_ORDER would be a test that cannot fail. The filters are: the window must also
 *  carry the sibling layer labels, and must NOT be the `teammate_spawn` resolver, which is a genuinely
 *  different chain (it has a `"default"` layer the Task path has no equivalent for). Ambiguity is a
 *  FAILURE below, not a silent pick. */
function resolutionChains(elf: string): string[] {
  return offsetsOf(elf, '"frontmatter"')
    .map((off) => windowAt(elf, off, 260, 560))
    .filter((w) => w.includes('"tool"') && w.includes('"env"') && !w.includes("teammate_spawn"));
}

const ELF = stagedAgentElf();

describe("sub-agent model precedence matches the agent binary", () => {
  it.skipIf(!ELF)("the binary resolves tool > frontmatter > env", () => {
    const chains = resolutionChains(ELF as string);
    // Exactly one, or the anchor has stopped identifying the Task resolver and the assertion below would
    // be measuring something else.
    expect(chains.length, `expected 1 Task model-resolution chain, found ${chains.length}`).toBe(1);
    const order = (chains[0].match(/"(tool|frontmatter|env|inherit|default)"/g) ?? [])
      .map((q) => q.slice(1, -1))
      .filter((l) => l !== "inherit"); // the fallback layer appears on several branches, not in rank order
    expect([...new Set(order)]).toEqual([...EXPECTED_ORDER]);
  });

  // NOT skipIf: this is the half CI can enforce — it catches a doc edit that reintroduces the old claim,
  // which is how the wrong order survived in three places for as long as it did.
  it("the shipped docs state that order, and never the reverse", () => {
    for (const f of ["docs/session.md", "docs/subagents.md", "src/session.ts"]) {
      const text = readFileSync(f, "utf8");
      expect(
        /env\s*>\s*dispatch param\s*>\s*frontmatter/i.test(text),
        `${f} states the REVERSED precedence (env first). The binary puts env BELOW frontmatter; see this test's header.`,
      ).toBe(false);
    }
  });
});
