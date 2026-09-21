import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { computeSkillInvocationVerdict, gradedSkillNameFor, commandShadowsSkillFor } from "../src/critique/command.js";
import { snapshotTurnBoundary } from "../src/critique/evidence.js";
import { binaryPluginIdentity } from "../src/session.js";

// The verdict WIRING — plugin tree → qualifier, events.jsonl → sub-agent channel, result.json → tool +
// slash channels — over real file shapes, with no run. Every earlier test sat at the function boundary
// below this, and the defect that motivated the file lived exactly here: the qualifier was read from a
// manifest the binary ignores, so a fully-invoked run graded as never invoked. The plugin-name rule is
// the BINARY's, measured (host agent 2.1.278, API unreachable, persisted transcript as the oracle):
// `.claude-plugin/plugin.json#name` wins; no manifest → directory basename; a root-level `plugin.json`
// is IGNORED (`rootpj-dir/plugin.json` = {"name":"rootpj-name"} registers as `rootpj-dir:qux`).

const tmpDirs: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  tmpDirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

type ManifestShape = "dot-claude-plugin" | "root-only" | "none";
function makePlugin(dirName: string, skill: string, manifest: ManifestShape, manifestName: string, withCommand = false): string {
  const parent = tmp("cwh-inv-");
  const root = join(parent, dirName);
  mkdirSync(join(root, "skills", skill), { recursive: true });
  writeFileSync(join(root, "skills", skill, "SKILL.md"), `---\nname: ${skill}\n---\n# ${skill}\n`);
  if (manifest === "dot-claude-plugin") {
    mkdirSync(join(root, ".claude-plugin"), { recursive: true });
    writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: manifestName }));
  } else if (manifest === "root-only") {
    writeFileSync(join(root, "plugin.json"), JSON.stringify({ name: manifestName }));
  }
  if (withCommand) {
    mkdirSync(join(root, "commands"), { recursive: true });
    writeFileSync(join(root, "commands", `${skill}.md`), "# a command with the skill's name\n");
  }
  return root;
}

/** A graded run's on-disk record: turns/1/result.json + events.jsonl in the shapes the harness writes. */
function makeRun(result: Record<string, unknown>, eventsLines: string[]): string {
  const outDir = tmp("cwh-inv-run-");
  mkdirSync(join(outDir, "turns", "1"), { recursive: true });
  writeFileSync(join(outDir, "turns", "1", "result.json"), JSON.stringify(result));
  writeFileSync(join(outDir, "events.jsonl"), eventsLines.map((l) => l + "\n").join(""));
  writeFileSync(join(outDir, "timeline.jsonl"), "");
  return outDir;
}
const frame = (parent: string | null, skill: string) =>
  JSON.stringify({
    type: "assistant",
    parent_tool_use_id: parent,
    message: { content: [{ type: "tool_use", name: "Skill", id: "t", input: { skill } }] },
  });

function verdict(pluginRoot: string, skill: string, result: Record<string, unknown>, events: string[] = []) {
  const outDir = makeRun(result, events);
  const resolved = { skillDir: join(pluginRoot, "skills", skill), pluginRoot, autoSelectedSkill: undefined };
  const gradedSkillName = gradedSkillNameFor(skill, resolved);
  return computeSkillInvocationVerdict({ outDir, boundary: snapshotTurnBoundary(outDir), taskRaw: result, resolved, gradedSkillName });
}

describe("binaryPluginIdentity — the binary's plugin-name rule", () => {
  it("prefers .claude-plugin/plugin.json#name over the directory", () => {
    expect(binaryPluginIdentity(makePlugin("plug-dirname", "s", "dot-claude-plugin", "plug-manifest")).name).toBe("plug-manifest");
  });
  it("falls back to the directory basename with no manifest", () => {
    expect(binaryPluginIdentity(makePlugin("nomanifest-plug", "s", "none", "")).name).toBe("nomanifest-plug");
  });
  it("IGNORES a root-level plugin.json — the binary does", () => {
    expect(binaryPluginIdentity(makePlugin("rootpj-dir", "s", "root-only", "rootpj-name")).name).toBe("rootpj-dir");
  });
});

describe("computeSkillInvocationVerdict over real file shapes", () => {
  it("root-only plugin.json: the binary registers `<dir>:<skill>` and BOTH channels naming it read as invoked", () => {
    // The pre-fix wiring read the manifest name `rootpj-name` as the required qualifier and returned
    // false over this exact record — the headline false negative, on a plugin shape the harness itself
    // recognises as a plugin root.
    const root = makePlugin("rootpj-dir", "qux", "root-only", "rootpj-name");
    const inv = { availableSkills: [{ id: "rootpj-dir:qux" }] };
    expect(verdict(root, "qux", { prompt: "/rootpj-dir:qux go", context: inv, skillActivity: [{ skillId: "(root)" }] })).toBe(true);
    expect(verdict(root, "qux", { prompt: "plain prose", context: inv, skillActivity: [{ skillId: "rootpj-dir:qux" }] })).toBe(true);
  });

  it("manifest name ≠ directory name: the manifest name is the qualifier", () => {
    const root = makePlugin("plug-dirname", "foo", "dot-claude-plugin", "plug-manifest");
    const inv = { availableSkills: [{ id: "plug-manifest:foo" }] };
    expect(verdict(root, "foo", { prompt: "/foo go", context: inv, skillActivity: [] })).toBe(true);
    // A `Skill` call carrying the DIRECTORY name as qualifier is some other plugin's skill: not this one.
    expect(verdict(root, "foo", { prompt: "prose", context: inv, skillActivity: [{ skillId: "plug-dirname:foo" }] })).toBe(false);
  });

  it("no manifest: a same-named skill from another plugin does NOT count (the qualifier is the basename, never unknown)", () => {
    const root = makePlugin("nomanifest-plug", "zed", "none", "");
    const inv = { availableSkills: [{ id: "nomanifest-plug:zed" }, { id: "other-plug:zed" }] };
    expect(verdict(root, "zed", { prompt: "prose", context: inv, skillActivity: [{ skillId: "other-plug:zed" }] })).toBe(false);
    expect(verdict(root, "zed", { prompt: "prose", context: inv, skillActivity: [{ skillId: "nomanifest-plug:zed" }] })).toBe(true);
  });

  it("a sub-agent's Skill call, read from events.jsonl, counts", () => {
    const root = makePlugin("fx", "deck-review", "dot-claude-plugin", "fx");
    const inv = { availableSkills: [{ id: "fx:deck-review" }] };
    const events = [frame(null, "fx:other"), frame("toolu_P", "fx:deck-review")];
    expect(verdict(root, "deck-review", { prompt: "prose", context: inv, skillActivity: [{ skillId: "(root)" }] }, events)).toBe(true);
  });

  it("a parented Skill call with no name makes the verdict absent, never false", () => {
    const root = makePlugin("fx", "deck-review", "dot-claude-plugin", "fx");
    const inv = { availableSkills: [{ id: "fx:deck-review" }] };
    const unnamed = JSON.stringify({
      type: "assistant",
      parent_tool_use_id: "toolu_P",
      message: { content: [{ type: "tool_use", name: "Skill", input: {} }] },
    });
    expect(verdict(root, "deck-review", { prompt: "prose", context: inv, skillActivity: [] }, [unnamed])).toBe(undefined);
  });

  it("a command shadowing the skill withholds a positive on the tool channel", () => {
    const root = makePlugin("vercel", "bootstrap", "dot-claude-plugin", "vercel", true);
    expect(commandShadowsSkillFor("bootstrap", { pluginRoot: root })).toBe(true);
    const inv = { availableSkills: [{ id: "vercel:bootstrap" }] };
    expect(verdict(root, "bootstrap", { prompt: "prose", context: inv, skillActivity: [{ skillId: "vercel:bootstrap" }] })).toBe(undefined);
  });

  it("no prompt or inventory in the record → absent", () => {
    const root = makePlugin("fx", "deck-review", "dot-claude-plugin", "fx");
    expect(verdict(root, "deck-review", { skillActivity: [{ skillId: "(root)" }] })).toBe(undefined);
  });
});

describe("gradedSkillNameFor", () => {
  it("--skill wins; then a single-skill plugin's auto-selection", () => {
    expect(gradedSkillNameFor("a", { skillDir: "/p/skills/b", pluginRoot: "/p", autoSelectedSkill: "b" })).toBe("a");
    expect(gradedSkillNameFor(undefined, { skillDir: "/p/skills/b", pluginRoot: "/p", autoSelectedSkill: "b" })).toBe("b");
  });
  it("a `<plugin>/skills/<name>` positional (shape 2) names the skill by its directory", () => {
    expect(gradedSkillNameFor(undefined, { skillDir: "/p/skills/c", pluginRoot: "/p", autoSelectedSkill: undefined })).toBe("c");
  });
  it("a plain skill folder (root IS the skill) has no single named skill to check", () => {
    expect(gradedSkillNameFor(undefined, { skillDir: "/s", pluginRoot: "/s", autoSelectedSkill: undefined })).toBe(undefined);
    expect(gradedSkillNameFor(undefined, { skillDir: "/s", pluginRoot: undefined, autoSelectedSkill: undefined })).toBe(undefined);
  });
});
