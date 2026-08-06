import { describe, it, expect } from "vitest";
import { parse } from "yaml";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Structural guards on the workflows themselves. A workflow is the one part of CI that CI cannot check:
// a job that never blocks a merge, a `docker build --platform linux/arm64` on an x86 runner, or a key
// GitHub silently ignores all look exactly like a working config until the day they matter.
//
// These are OFFLINE guards over the YAML. They complement `scripts/release-preflight.ts`, which checks
// the other direction (live ruleset contexts -> job names) and needs `gh` + admin scope. Note the `yaml`
// package parses per YAML 1.2, so the `on:` key stays the string "on" and is NOT folded to boolean true
// (the YAML 1.1 trap) — verified, not assumed.

const WF_DIR = join(".github", "workflows");

interface Job {
  name?: string;
  "runs-on"?: string;
  needs?: string | string[];
  steps?: unknown[];
  paths?: unknown;
}
interface Workflow {
  name?: string;
  on?: { push?: { branches?: string[]; tags?: string[]; paths?: string[] } };
  jobs?: Record<string, Job | null>;
}

function workflows(): { file: string; doc: Workflow }[] {
  return readdirSync(WF_DIR)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .sort()
    .map((file) => ({ file, doc: parse(readFileSync(join(WF_DIR, file), "utf8")) as Workflow }));
}

const ci = () => workflows().find((w) => w.file === "ci.yml")!.doc;
const needsOf = (j: Job | null): string[] => (j?.needs === undefined ? [] : Array.isArray(j.needs) ? j.needs : [j.needs]);

/** Contexts the `main` branch ruleset requires. The ruleset lives in GitHub settings, not in this repo,
 *  so nothing here can see it drift — these strings were read from the live ruleset on 2026-08-06 and are
 *  duplicated deliberately, as the offline half of the same guarantee release-preflight checks online. */
const REQUIRED_CONTEXTS = ["typecheck · test · build", "pytest helper lane (-m 'not cowork')"];

/** Jobs that run in CI but do NOT block a merge. This list is not an endorsement — it exists so that
 *  ADDING a job forces a conscious choice between "gates a merge" and "does not", instead of defaulting
 *  to "does not" silently. A new job belongs in `ci-green.needs` or here, with a reason. */
const NON_GATING: Record<string, string> = {
  "action-self-test": "exercises the packaged Action end-to-end; informative, not merge-blocking",
  boundary: "arm64 container parity lane; long-running",
  scenarios: "live-inference suite — skips itself without ANTHROPIC_API_KEY, so it cannot gate",
  "parity-drift": "watches upstream Desktop; drift is news about the world, not a defect in the PR",
};

describe("ci.yml merge gating", () => {
  it("has a job named for each required ruleset context", () => {
    const names = Object.values(ci().jobs ?? {}).map((j) => j?.name);
    for (const ctx of REQUIRED_CONTEXTS) expect(names).toContain(ctx);
  });

  it("routes every job to a merge gate or an explicit non-gating reason", () => {
    // A required context is satisfied by ONE job; everything that must block a merge has to be reachable
    // from it via `needs`. `ci-green` is a no-op job whose entire purpose is to be that funnel, so a new
    // job absent from its `needs` runs on every PR and blocks nothing — green CI, unguarded merge.
    const jobs = ci().jobs ?? {};
    const roots = Object.entries(jobs)
      .filter(([, j]) => j?.name !== undefined && REQUIRED_CONTEXTS.includes(j.name))
      .map(([id]) => id);
    expect(roots.length).toBe(REQUIRED_CONTEXTS.length);

    const gated = new Set<string>();
    const queue = [...roots];
    while (queue.length) {
      const id = queue.shift()!;
      if (gated.has(id)) continue;
      gated.add(id);
      queue.push(...needsOf(jobs[id] ?? null));
    }

    const ungoverned = Object.keys(jobs).filter((id) => !gated.has(id) && !(id in NON_GATING));
    expect(ungoverned).toEqual([]);
  });
});

describe("every workflow", () => {
  it("declares no per-job `paths` filter", () => {
    // Path filters are workflow-level (`on.push.paths`). GitHub silently ignores an unknown `paths` key
    // on a job, so this reads as a working per-job filter while the job runs unconditionally.
    for (const { file, doc } of workflows()) {
      for (const [id, job] of Object.entries(doc.jobs ?? {})) {
        expect(job?.paths, `${file}: job "${id}" declares a job-level paths filter, which does not exist`).toBeUndefined();
      }
    }
  });

  it("runs arm64 image builds on an arm64 runner", () => {
    // `docker build --platform linux/arm64` on an x86 runner needs QEMU/binfmt that is not set up here;
    // without it the build fails, and with it the build is slow and subtly different from production.
    for (const { file, doc } of workflows()) {
      for (const [id, job] of Object.entries(doc.jobs ?? {})) {
        const steps = JSON.stringify(job?.steps ?? []);
        if (!/--platform[= ]linux\/arm64/.test(steps)) continue;
        expect(job?.["runs-on"], `${file}: job "${id}" builds arm64 but does not run on an arm64 runner`).toBe("ubuntu-24.04-arm");
      }
    }
  });

  it("does not list its own file in its push path filter", () => {
    // Self-triggering: the very commit that introduces the filter matches it, so the first thing the new
    // trigger publishes is the untested new trigger. Edit the workflow via workflow_dispatch instead.
    for (const { file, doc } of workflows()) {
      const paths = doc.on?.push?.paths ?? [];
      expect(paths, `${file}: lists itself in on.push.paths, so editing it triggers itself`).not.toContain(`.github/workflows/${file}`);
    }
  });
});
