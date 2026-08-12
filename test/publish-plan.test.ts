import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";

// Behavioural test of publish-image.yml's "Resolve the publish plan" step.
//
// This exists because syntax checks cannot see semantics. The step's shell parsed fine, every `run:`
// block was bash-checked, and the collision guard was exercised in isolation — but `push_floating` was
// assigned the value of `immutable_only` rather than its negation, so the one run whose entire purpose
// was to leave the floating `:2` tag alone moved it. An inverted boolean is invisible to every check
// except executing the branch.
//
// The step is extracted from the workflow and run for real, with GitHub's `${{ }}` expressions
// substituted, so the assertion is against the shipped source rather than a copy of it.

interface Workflow {
  jobs?: Record<string, { steps?: { name?: string; id?: string; run?: string }[] }>;
}

function planScript(): string {
  const doc = parse(readFileSync(join(".github", "workflows", "publish-image.yml"), "utf8")) as Workflow;
  const step = doc.jobs?.publish?.steps?.find((s) => s.id === "plan");
  if (!step?.run) throw new Error("publish-image.yml has no step with id 'plan' — did it get renamed?");
  return step.run;
}

/** Run the real plan step with a given event + input, returning the key=value pairs it wrote. */
function runPlan(eventName: string, immutableOnly: string): Record<string, string> {
  const script = planScript().replaceAll("${{ github.event_name }}", eventName).replaceAll("${{ inputs.immutable_only }}", immutableOnly);
  const dir = mkdtempSync(join(tmpdir(), "publish-plan-"));
  const outFile = join(dir, "gh_output");
  writeFileSync(outFile, "");
  execFileSync("bash", ["-c", script], { env: { ...process.env, GITHUB_OUTPUT: outFile }, encoding: "utf8" });
  return Object.fromEntries(
    readFileSync(outFile, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
}

describe("publish-image.yml publish plan", () => {
  it("a manual run with immutable_only leaves the floating :2 tag alone", () => {
    const p = runPlan("workflow_dispatch", "true");
    expect(p.push_floating).toBe("false"); // the regression: this read "true"
    expect(p.push_rtag).toBe("true");
    expect(p.push_vtag).toBe("false");
  });

  it("a manual run without immutable_only does move :2", () => {
    const p = runPlan("workflow_dispatch", "false");
    expect(p.push_floating).toBe("true");
    expect(p.push_rtag).toBe("true");
  });

  it("a release tag push publishes the version co-tag but does NOT move the floating :2", () => {
    // The second regression of this exact class. The first was an inverted boolean on the dispatch
    // path; this one was a deliberate `push_floating=true` on the tag path, which meant every release
    // silently moved `:2` off the digest pinned in docker/agent-image.json. Nothing re-recorded the
    // pin, so tag and pin diverged permanently — and `doctor` (checks the pin) disagreed with CI
    // (pulls the tag) about which image was correct.
    //
    // `:2` is a curated pointer: moved only by a deliberate dispatch, in the release that also ships
    // the updated pin (docs/maintenance.md). Tagging a release must not be a side channel for it.
    const p = runPlan("push", "");
    expect(p.push_floating).toBe("false"); // the regression: this read "true"
    expect(p.push_vtag).toBe("true");
    expect(p.push_rtag).toBe("false");
  });

  it("moving :2 requires an explicit dispatch — no event can move it implicitly", () => {
    // The property that matters, asserted across every reachable (event, input) combination rather
    // than per-case: the ONLY way `:2` moves is a workflow_dispatch that explicitly opts out of
    // immutable_only. If a future edit reintroduces a floating push on any other path, this fails
    // even if someone also "fixed" the case above to match the new behaviour.
    const combos: [string, string][] = [
      ["push", ""],
      ["workflow_dispatch", "true"],
      ["workflow_dispatch", "false"],
    ];
    const movers = combos.filter(([e, i]) => runPlan(e, i).push_floating === "true");
    expect(movers).toEqual([["workflow_dispatch", "false"]]);
  });

  it("reads the revision from docker/agent-image.json, not from an input", () => {
    const manifest = JSON.parse(readFileSync(join("docker", "agent-image.json"), "utf8")) as { revision: number };
    expect(runPlan("workflow_dispatch", "true").revision).toBe(String(manifest.revision));
  });
});
