import { describe, it, expect } from "vitest";
import { readdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderPrompts } from "../src/prompt.js";
import { loadBaseline, BASELINES_DIR, cmpVersionStrings } from "../src/baseline.js";
import { SessionConfig } from "../src/session.js";

const baselineFiles = readdirSync(BASELINES_DIR).filter((f) => f.startsWith("desktop-") && f.endsWith(".json"));

describe("baseline prompt-asset references", () => {
  // A repointed/typo'd promptTemplate would otherwise surface only at run time (a hard error in
  // renderPrompts) — guard it statically for every committed baseline.
  it.each(baselineFiles)("%s promptTemplate/subagentAppend resolve to committed files", (file) => {
    const b = JSON.parse(readFileSync(join(BASELINES_DIR, file), "utf8"));
    for (const key of ["promptTemplate", "subagentAppend", "subagentAppendHostLoop"] as const) {
      const rel = b.spawn?.[key];
      if (!rel) continue; // absent is legitimate (renderPrompts treats it as no asset)
      expect(existsSync(join(BASELINES_DIR, rel)), `${file} spawn.${key} -> ${rel}`).toBe(true);
    }
  });
});

describe("renderPrompts — desktop-1.18286.0 reconstruction", () => {
  // Loads the 1.18286.2 baseline JSON, not 1.18286.0: this block's own tests render hostloop, which
  // now requires spawn.subagentAppendHostLoop (only backfilled for the verified >=1.18286.2 window —
  // see the per-tier branch-selection describe below). 1.18286.2 points promptTemplate at the SAME
  // reconstructed "prompts/desktop-1.18286.0/system-prompt-append.md" asset this describe exercises,
  // so the rendered systemPromptAppend content this block asserts on is unchanged.
  const baseline = loadBaseline("desktop-1.18286.2");
  const sessionId = "vm_test123";

  it("leaves no unresolved {{…}} tokens (account_name unset — default path)", () => {
    const session = SessionConfig.parse({});
    const { systemPromptAppend, subagentAppend } = renderPrompts(baseline, session, sessionId, "project", {
      effectiveFidelity: "container",
    });
    for (const rendered of [systemPromptAppend, subagentAppend]) {
      expect(rendered).toBeTruthy();
      expect(rendered).not.toMatch(/\{\{[^}]*\}\}/);
    }
    expect(systemPromptAppend).toContain("User name: User"); // {{accountName}} default
  });

  it("leaves no unresolved tokens and honors account_name when set", () => {
    const session = SessionConfig.parse({ account_name: "Yaniv" });
    const { systemPromptAppend } = renderPrompts(baseline, session, sessionId, "project", { effectiveFidelity: "container" });
    expect(systemPromptAppend).not.toMatch(/\{\{[^}]*\}\}/);
    expect(systemPromptAppend).toContain("User name: Yaniv");
  });

  it("carries the key behavior-driving sections", () => {
    const session = SessionConfig.parse({});
    const { systemPromptAppend } = renderPrompts(baseline, session, sessionId, "project", { effectiveFidelity: "container" });
    for (const tag of [
      "<application_details>",
      "<claude_behavior>",
      "<tone_and_formatting>",
      "<ask_user_question_tool>",
      "<todo_list_tool>",
      "<computer_use>",
      "<env>",
    ])
      expect(systemPromptAppend).toContain(tag);
    // The load-bearing identity correction must survive every re-paraphrase.
    expect(systemPromptAppend).toContain("NOT Claude Code");
  });

  it("the rendered (non-hostloop) asset contains the instructed computer:// link form", () => {
    // sharing_files now INSTRUCTS computer:// links faithfully. At non-hostloop fidelity
    // {{workspaceFolder}} renders a VM path — that's the production-faithful un-rewritten model
    // context (production's model context keeps /sessions/… forever; only the DISPLAY layer, at
    // hostloop, rewrites it — see src/run/display-translate.ts + the computer_links_resolve
    // assertion in test/computer-links-resolve.test.ts). No leak: this is model-visible text.
    const session = SessionConfig.parse({});
    const { systemPromptAppend } = renderPrompts(baseline, session, sessionId, "project", { effectiveFidelity: "container" });
    expect(systemPromptAppend).toContain(`computer:///sessions/${sessionId}/mnt/project/report.docx`);
  });

  it("the rendered HOSTLOOP asset's computer:// link carries the HOST workspace path, with no /sessions/ remnant", () => {
    const session = SessionConfig.parse({});
    const { systemPromptAppend } = renderPrompts(baseline, session, sessionId, "project", {
      effectiveFidelity: "hostloop",
      hostCwd: "/Users/me/.cowork-harness/runs/scenario/vm_test123/work/session/mnt/outputs",
      hostUploadsDir: "/Users/me/uploads-staging/vm_test123",
      hostWorkspaceFolder: "/Users/me/Project",
      hostSkillsDir: "/Users/me/.cowork-harness/config/skills",
    });
    const rendered = systemPromptAppend!;
    const link = "computer:///Users/me/Project/report.docx";
    expect(rendered).toContain(link);
    expect(link).not.toMatch(/\/sessions\//);
  });

  it("renders both with and without a connected folder", () => {
    const session = SessionConfig.parse({});
    const noFolder = renderPrompts(baseline, session, sessionId, undefined, { effectiveFidelity: "container" }).systemPromptAppend!;
    expect(noFolder).toContain(`/sessions/${sessionId}/mnt/outputs`); // workspaceFolder falls back to outputs
    expect(noFolder).toContain("User selected a folder: false");
    const withFolder = renderPrompts(baseline, session, sessionId, "project", { effectiveFidelity: "container" }).systemPromptAppend!;
    expect(withFolder).toContain(`/sessions/${sessionId}/mnt/project`);
    expect(withFolder).toContain("User selected a folder: true");
  });
});

describe("renderPrompts — host-loop token substitution (P2a)", () => {
  // See the comment on the describe above: every test here renders hostloop, which requires the
  // subagentAppendHostLoop pointer (backfilled starting at 1.18286.2, not 1.18286.0).
  const baseline = loadBaseline("desktop-1.18286.2");
  const sessionId = "vm_test123";

  it("substitutes {{cwd}}/{{workspaceFolder}}/{{skillsDir}} with HOST paths, and fires the uploads pre-replacement (no naive <hostCwd>/mnt/uploads join)", () => {
    const session = SessionConfig.parse({});
    const { systemPromptAppend } = renderPrompts(baseline, session, sessionId, "project", {
      effectiveFidelity: "hostloop",
      hostCwd: "/Users/me/.cowork-harness/runs/scenario/vm_test123/work/session/mnt/outputs",
      hostUploadsDir: "/Users/me/uploads-staging/vm_test123",
      hostWorkspaceFolder: "/Users/me/Project",
      hostSkillsDir: "/Users/me/.cowork-harness/config/skills",
    });
    expect(systemPromptAppend).toBeTruthy();
    const rendered = systemPromptAppend!;
    // {{cwd}} -> hostCwd
    expect(rendered).toContain("/Users/me/.cowork-harness/runs/scenario/vm_test123/work/session/mnt/outputs");
    // {{workspaceFolder}} -> hostWorkspaceFolder (NOT the VM path)
    expect(rendered).toContain("/Users/me/Project");
    // {{skillsDir}} -> hostSkillsDir
    expect(rendered).toContain("/Users/me/.cowork-harness/config/skills");
    // the dedicated uploads pre-replacement fired: the literal "{{cwd}}/mnt/uploads" resolved to
    // hostUploadsDir, NOT to a naive `<hostCwd>/mnt/uploads` join (which would be a DIFFERENT string here).
    expect(rendered).toContain("/Users/me/uploads-staging/vm_test123");
    expect(rendered).not.toContain("/Users/me/.cowork-harness/runs/scenario/vm_test123/work/session/mnt/outputs/mnt/uploads");
    // no VM-shaped /sessions/ paths should remain from these four tokens.
    expect(rendered).not.toContain(`/sessions/${sessionId}/mnt`);
    // no unresolved tokens.
    expect(rendered).not.toMatch(/\{\{[^}]*\}\}/);
  });

  it("falls back {{skillsDir}} to the verbatim no-skills string when hostSkillsDir is undefined", () => {
    const session = SessionConfig.parse({});
    const { systemPromptAppend } = renderPrompts(baseline, session, sessionId, "project", {
      effectiveFidelity: "hostloop",
      hostCwd: "/Users/me/runs/x/work/session/mnt/outputs",
      hostUploadsDir: "/Users/me/runs/x/work/session/mnt/uploads",
      hostWorkspaceFolder: "/Users/me/Project",
      // hostSkillsDir intentionally omitted
    });
    expect(systemPromptAppend).toContain("(no skills directory — skip skill reads)");
    expect(systemPromptAppend).not.toMatch(/\{\{[^}]*\}\}/);
  });

  it("falls back {{workspaceFolder}} to hostCwd when no folder is connected", () => {
    const session = SessionConfig.parse({});
    const { systemPromptAppend } = renderPrompts(baseline, session, sessionId, undefined, {
      effectiveFidelity: "hostloop",
      hostCwd: "/Users/me/runs/x/work/session/mnt/outputs",
    });
    // both {{cwd}} and {{workspaceFolder}} render the SAME hostCwd fallback.
    const occurrences = systemPromptAppend!.split("/Users/me/runs/x/work/session/mnt/outputs").length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
    expect(systemPromptAppend).not.toMatch(/\{\{[^}]*\}\}/);
  });

  it("non-hostloop tiers are byte-identical to rendering with no hostLoopOpts at all", () => {
    const session = SessionConfig.parse({ account_name: "Yaniv" });
    const withoutOpts = renderPrompts(baseline, session, sessionId, "project", { effectiveFidelity: "container" }).systemPromptAppend;
    const withIgnoredOpts = renderPrompts(baseline, session, sessionId, "project", {
      effectiveFidelity: "container", // not "hostloop" — every hostLoopOpts field must be ignored
      hostCwd: "/should/not/appear",
      hostUploadsDir: "/should/not/appear/either",
    }).systemPromptAppend;
    expect(withIgnoredOpts).toBe(withoutOpts);
    expect(withIgnoredOpts).not.toContain("/should/not/appear");
  });
});

describe("subagentAppend — per-tier branch selection (subagent_env_hl / subagent_env_vm)", () => {
  // `latest`, deliberately — NOT a pinned historical baseline. Frozen at desktop-1.20186.1 this block
  // asserted real hl-vs-vm content semantics that could never observe a repoint of the CURRENT baseline,
  // so it read as coverage while being inert for the pointer that production actually renders. Against
  // `latest` the same assertions cover the shipping asset. (It does not, on its own, catch a pointer left
  // on a STALE hl asset — an outdated hl paraphrase still satisfies every assertion here, because it is
  // still a correct hl asset. That is the pointer-coupling check's job, not this one's.)
  const baseline = loadBaseline("latest");
  const session = SessionConfig.parse({});
  const sessionId = "vm_test123";
  const hlOpts = {
    effectiveFidelity: "hostloop",
    hostCwd: "/Users/me/runs/x/work/session/mnt/outputs",
    hostUploadsDir: "/Users/me/runs/x/work/session/mnt/uploads",
  };

  it("hostloop renders the hl asset: host cwd for file tools, VM root for the bash mount clause", () => {
    const { subagentAppend } = renderPrompts(baseline, session, sessionId, undefined, hlOpts);
    expect(subagentAppend).toBeTruthy();
    // {{cwd}} -> host cwd (file tools reach the real filesystem there)
    expect(subagentAppend).toContain("/Users/me/runs/x/work/session/mnt/outputs");
    // {{vmCwd}}/mnt/ -> the VM session root's mount path (bash side)
    expect(subagentAppend).toContain(`/sessions/${sessionId}/mnt/`);
    expect(subagentAppend).toContain("mcp__workspace__bash");
    expect(subagentAppend).not.toMatch(/\{\{[^}]*\}\}/);
    // the hl branch must NOT claim files exist only in a sandbox (that's the vm branch's claim)
    expect(subagentAppend!.toLowerCase()).not.toContain("only in the sandbox");
  });

  it("container and microvm both render the vm asset (identical bytes, VM paths, no hl claims)", () => {
    const vmC = renderPrompts(baseline, session, sessionId, undefined, { effectiveFidelity: "container" }).subagentAppend;
    const vmM = renderPrompts(baseline, session, sessionId, undefined, { effectiveFidelity: "microvm" }).subagentAppend;
    expect(vmC).toBeTruthy();
    expect(vmM).toBe(vmC);
    expect(vmC).toContain(`/sessions/${sessionId}`);
    expect(vmC).not.toContain("mnt/outputs/mnt"); // no double-substitution artifacts
  });

  it("protocol gets NO sub-agent append (decided divergence: neither branch text is true on that topology)", () => {
    const { subagentAppend } = renderPrompts(baseline, session, sessionId, undefined, { effectiveFidelity: "protocol" });
    expect(subagentAppend).toBeUndefined();
  });

  it("hostloop on a baseline WITHOUT the hl pointer fails loud — never silently falls back to the vm text", () => {
    const old = loadBaseline("desktop-1.15200.0"); // family predates the verified hl text window (>=1.18286.2)
    expect(() => renderPrompts(old, session, sessionId, undefined, hlOpts)).toThrow(/subagentAppendHostLoop/);
  });
});

/**
 * Pointer-coupling guard (trimmed "A2").
 *
 * THE FAIL-OPEN IT CLOSES. `checkSubagentPromptFacts` fingerprints the ASAR's hl/vm branch texts and
 * compares them to the newest `subagentAppendVersions` entry; it never reads the baseline's
 * `spawn.subagentAppendHostLoop`. `sync` carries that hand-authored pointer forward untouched. So
 * recording a new fingerprint entry CLEARS the sentinel whether or not the pointer moved, and a
 * host-loop sub-agent then receives the previous release's paraphrase with everything green. That
 * happened on 1.32885.1 and was caught by eye.
 *
 * THE RULE. When the newest entry's fingerprint differs from the second-newest's on an axis, the
 * newest baseline's pointer for that axis must differ from the previous baseline's. Both inputs are
 * already-committed data, so there is no new hand-authored field to copy-paste into compliance — which
 * is what sank the first design.
 *
 * WHAT IT CANNOT DO. The committed asset is a deliberate paraphrase, so faithfulness is unverifiable by
 * construction; this enforces COUPLING only. A maintainer who copies the old asset to a new path and
 * repoints satisfies it — that raises the cost of the fail-open from zero to two commands, no further.
 * Known residue, deliberately not guarded here: back-filling an older entry whose fingerprint equals the
 * newest's makes the delta vanish and silently disarms the rule; and the rule is dormant between
 * fingerprint moves (see BNEW below), which is most releases.
 */
type CouplingEntry = { hl: string; vm: string };
type CouplingBaseline = { appVersion: string; hl?: string; vm?: string };
const AXES = [
  { key: "hl" as const, pointer: "spawn.subagentAppendHostLoop" },
  { key: "vm" as const, pointer: "spawn.subagentAppend" },
];

export function checkPointerCoupling(
  entries: Record<string, CouplingEntry>,
  baselines: readonly CouplingBaseline[],
): { findings: string[]; notes: string[] } {
  const findings: string[] = [];
  const notes: string[] = [];
  const versions = Object.keys(entries).sort(cmpVersionStrings);
  if (versions.length < 2) {
    notes.push("pointer-coupling: fewer than two subagentAppendVersions entries — a delta rule needs two; dormant");
    return { findings, notes };
  }
  const e1v = versions[versions.length - 1];
  const E1 = entries[e1v];
  const E0 = entries[versions[versions.length - 2]];
  const sorted = [...baselines].sort((a, b) => cmpVersionStrings(a.appVersion, b.appVersion));
  const Bnew = sorted[sorted.length - 1];
  // BNEW: the guard is about the pointer PRODUCTION renders, so it must be the newest baseline — not
  // "the baseline at the entry's version", which silently freezes the check on a historical pair the
  // moment an ordinary sync ships without moving the fingerprint. Engaging only when the two coincide
  // keeps the subject honest AND skips the maintainer's working window (entry committed, baseline not
  // yet), which sync's own refusal already covers.
  if (!Bnew || Bnew.appVersion !== e1v) {
    notes.push(
      `pointer-coupling: newest baseline ${Bnew?.appVersion ?? "(none)"} is not the newest entry's version ${e1v} — dormant until the next fingerprint move`,
    );
    return { findings, notes };
  }
  const Bprev = sorted.filter((b) => cmpVersionStrings(b.appVersion, e1v) < 0).pop();
  if (!Bprev) {
    notes.push(`pointer-coupling: no baseline older than ${e1v} — no previous pointer to compare against`);
    return { findings, notes };
  }
  for (const { key, pointer } of AXES) {
    if (E1[key] === E0[key]) continue; // no drift recorded on this axis -> no requirement (the ordinary-sync case)
    // An absent pointer is legitimate per the resolve-only check above. At hl renderPrompts throws at
    // run time; at vm it silently renders no append — noted rather than failed, since the pointer this
    // rule is about was never set.
    if (Bnew[key] === undefined) {
      notes.push(`pointer-coupling: ${pointer} absent on ${Bnew.appVersion}; ${key} drift not checked`);
      continue;
    }
    if (Bnew[key] === Bprev[key])
      findings.push(
        `pointer-coupling: ${e1v} records a ${key} fingerprint change (${E0[key]} -> ${E1[key]}) but ${pointer} still points at ${Bnew[key]} — the same asset ${Bprev.appVersion} used. Repoint it at the new paraphrase, or the ${key} sub-agent append ships stale.`,
      );
  }
  return { findings, notes };
}

describe("sub-agent append pointer coupling", () => {
  const realEntries = JSON.parse(readFileSync(join(BASELINES_DIR, "prompts", "cowork-system-prompt-fingerprints.json"), "utf8"))
    .subagentAppendVersions as Record<string, CouplingEntry>;
  const realBaselines: CouplingBaseline[] = baselineFiles.map((f) => {
    const b = JSON.parse(readFileSync(join(BASELINES_DIR, f), "utf8"));
    return { appVersion: b.appVersion, hl: b.spawn?.subagentAppendHostLoop, vm: b.spawn?.subagentAppend };
  });

  it("the committed tree is coupled", () => {
    const { findings } = checkPointerCoupling(realEntries, realBaselines);
    expect(findings).toEqual([]);
  });

  // --- mutation battery: a guard never seen to fail is not known to work ---
  const E = { "1.0.0": { hl: "aaa", vm: "zzz" }, "2.0.0": { hl: "bbb", vm: "zzz" } };
  const B = [
    { appVersion: "1.0.0", hl: "prompts/old/subagent-append-hl.md", vm: "prompts/v/subagent-append-vm.md" },
    { appVersion: "2.0.0", hl: "prompts/new/subagent-append-hl.md", vm: "prompts/v/subagent-append-vm.md" },
  ];

  it("passes when the hl fingerprint moved AND the pointer moved", () => {
    expect(checkPointerCoupling(E, B).findings).toEqual([]);
  });

  it("FIRES when the hl fingerprint moved and the pointer did not — the 1.32885.1 bug", () => {
    const stale = [B[0], { ...B[1], hl: B[0].hl }];
    const { findings } = checkPointerCoupling(E, stale);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("subagentAppendHostLoop");
  });

  it("FIRES on the vm axis symmetrically", () => {
    const vmMoved = { "1.0.0": { hl: "aaa", vm: "yyy" }, "2.0.0": { hl: "aaa", vm: "zzz" } };
    const { findings } = checkPointerCoupling(vmMoved, B);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("spawn.subagentAppend ");
  });

  it("stays SILENT when no fingerprint moved, even with an unchanged pointer (the ordinary sync)", () => {
    const same = { "1.0.0": { hl: "aaa", vm: "zzz" }, "2.0.0": { hl: "aaa", vm: "zzz" } };
    expect(checkPointerCoupling(same, [B[0], { ...B[1], hl: B[0].hl }]).findings).toEqual([]);
  });

  it("is dormant (note, not finding) while the entry's baseline is uncommitted", () => {
    const r = checkPointerCoupling(E, [B[0]]); // entry 2.0.0 exists, its baseline does not
    expect(r.findings).toEqual([]);
    expect(r.notes.join(" ")).toContain("dormant until the next fingerprint move");
  });

  it("is dormant with a single entry", () => {
    const r = checkPointerCoupling({ "1.0.0": { hl: "aaa", vm: "zzz" } }, B);
    expect(r.findings).toEqual([]);
    expect(r.notes.join(" ")).toContain("fewer than two");
  });

  it("notes rather than fails when the pointer is absent on the newest baseline", () => {
    const r = checkPointerCoupling(E, [B[0], { appVersion: "2.0.0", vm: B[1].vm }]);
    expect(r.findings).toEqual([]);
    expect(r.notes.join(" ")).toContain("absent");
  });

  it("selects newest by version order, not key order", () => {
    const unsorted = { "2.0.0": { hl: "bbb", vm: "zzz" }, "1.0.0": { hl: "aaa", vm: "zzz" } };
    const stale = [B[0], { ...B[1], hl: B[0].hl }];
    expect(checkPointerCoupling(unsorted, stale).findings).toHaveLength(1);
  });
});
