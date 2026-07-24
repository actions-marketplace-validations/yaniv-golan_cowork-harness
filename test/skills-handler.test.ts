import { describe, it, expect } from "vitest";
import { makeSkillsHandler, SUGGEST_SKILLS_CAP } from "../src/hostloop/skills-handler.js";
import type { MountedSkill } from "../src/run/skill-metadata.js";

// Token-free, filesystem-free coverage for the `skills` sdk-MCP server (A2): tool-set gating across all
// three suggestSkillsEnabled/proactiveSkillSuggestEnabled states, alwaysLoad, output envelope shape, and
// the note-branch/cap fidelity bits called out in the confirmation spec §5/§6.

const SKILL_A: MountedSkill = { name: "my-pdf-skill", description: "Extracts tables from PDFs", isUserCreated: true };
const SKILL_B: MountedSkill = { name: "founder-skills:deck-review", description: "Reviews pitch decks", isUserCreated: false };

async function listTools(h: ReturnType<typeof makeSkillsHandler>) {
  const out: any = await h("skills", { method: "tools/list" });
  return out.result.tools as Array<{ name: string; description: string; inputSchema: any; _meta?: any }>;
}

async function callTool(h: ReturnType<typeof makeSkillsHandler>, name: string, args: Record<string, unknown> = {}) {
  const out: any = await h("skills", { method: "tools/call", params: { name, arguments: args } });
  return out;
}

function parseText(out: any): any {
  return JSON.parse(out.result.content[0].text);
}

describe("makeSkillsHandler — tool-set gating", () => {
  it("suggestSkillsEnabled:true, proactive:false → list_skills + base suggest_skills, both alwaysLoad", async () => {
    const h = makeSkillsHandler({
      mountedSkills: [],
      mountedPluginNames: [],
      suggestSkillsEnabled: true,
      proactiveSkillSuggestEnabled: false,
    });
    const tools = await listTools(h);
    expect(tools.map((t) => t.name).sort()).toEqual(["list_skills", "suggest_skills"]);
    for (const t of tools) expect(t._meta["anthropic/alwaysLoad"]).toBe(true);
    const suggest = tools.find((t) => t.name === "suggest_skills")!;
    expect(suggest.inputSchema.properties.trigger).toBeUndefined();
    const list = tools.find((t) => t.name === "list_skills")!;
    expect(list.description).toMatch(/fall back to suggest_skills/i);
  });

  it("suggestSkillsEnabled:false → suggest_skills omitted, list_skills description drops the fallback clause", async () => {
    const h = makeSkillsHandler({
      mountedSkills: [],
      mountedPluginNames: [],
      suggestSkillsEnabled: false,
      proactiveSkillSuggestEnabled: false,
    });
    const tools = await listTools(h);
    expect(tools.map((t) => t.name)).toEqual(["list_skills"]);
    expect(tools[0].description).not.toMatch(/suggest_skills/i);
  });

  it("suggestSkillsEnabled:true, proactive:true → suggest_skills gains a trigger enum param + proactive description", async () => {
    const h = makeSkillsHandler({
      mountedSkills: [],
      mountedPluginNames: [],
      suggestSkillsEnabled: true,
      proactiveSkillSuggestEnabled: true,
    });
    const tools = await listTools(h);
    const suggest = tools.find((t) => t.name === "suggest_skills")!;
    expect(suggest.inputSchema.properties.trigger).toEqual({ type: "string", enum: ["user_asked", "proactive"] });
    expect(suggest.description).toMatch(/proactive/i);
  });

  it("proactive:true is a no-op when suggestSkillsEnabled is false (gate #5 precedence)", async () => {
    const h = makeSkillsHandler({
      mountedSkills: [],
      mountedPluginNames: [],
      suggestSkillsEnabled: false,
      proactiveSkillSuggestEnabled: true,
    });
    const tools = await listTools(h);
    expect(tools.map((t) => t.name)).toEqual(["list_skills"]);
  });
});

describe("makeSkillsHandler — list_skills envelope + note branches", () => {
  const h = makeSkillsHandler({
    mountedSkills: [SKILL_A, SKILL_B],
    mountedPluginNames: ["founder-skills"],
    suggestSkillsEnabled: true,
    proactiveSkillSuggestEnabled: false,
  });

  it("non-empty match: resolved_skills populated, installed_plugins present, widget-rendered note", async () => {
    const out = parseText(await callTool(h, "list_skills", {}));
    expect(out.resolved_skills).toEqual([
      { name: "my-pdf-skill", description: "Extracts tables from PDFs", skill_id: "my-pdf-skill", is_user_created: true },
      {
        name: "founder-skills:deck-review",
        description: "Reviews pitch decks",
        skill_id: "founder-skills:deck-review",
        is_user_created: false,
      },
    ]);
    expect(out.installed_plugins).toEqual(["founder-skills"]);
    expect(out.request_skill_names).toEqual([]);
    expect(out.request_keywords).toEqual([]);
    expect(out.note).toMatch(/widget rendered above/i);
  });

  it("skill_names filters to the named subset", async () => {
    const out = parseText(await callTool(h, "list_skills", { skill_names: ["my-pdf-skill"] }));
    expect(out.resolved_skills.map((s: any) => s.name)).toEqual(["my-pdf-skill"]);
    expect(out.request_skill_names).toEqual(["my-pdf-skill"]);
  });

  it("empty-but-plugins-exist: no skill matches, plugins are named in the note", async () => {
    const out = parseText(await callTool(h, "list_skills", { skill_names: ["nonexistent"] }));
    expect(out.resolved_skills).toEqual([]);
    expect(out.note).toMatch(/no slash-menu skills matched/i);
    expect(out.note).toContain("founder-skills");
  });

  it("fully-empty: no skills, no plugins", async () => {
    const empty = makeSkillsHandler({
      mountedSkills: [],
      mountedPluginNames: [],
      suggestSkillsEnabled: true,
      proactiveSkillSuggestEnabled: false,
    });
    const out = parseText(await callTool(empty, "list_skills", {}));
    expect(out.resolved_skills).toEqual([]);
    expect(out.installed_plugins).toEqual([]);
    expect(out.note).toMatch(/no installed skills matched/i);
  });
});

describe("makeSkillsHandler — suggest_skills envelope", () => {
  it("base (non-proactive): resolved_skills empty (out-of-band catalog), no trigger key, ≤15 cap held trivially", async () => {
    const h = makeSkillsHandler({
      mountedSkills: [SKILL_A],
      mountedPluginNames: [],
      suggestSkillsEnabled: true,
      proactiveSkillSuggestEnabled: false,
    });
    const out = parseText(await callTool(h, "suggest_skills", { keywords: ["pdf"] }));
    expect(out.resolved_skills).toEqual([]);
    // NOT `[].length <= 15` — that is a tautology while the addable catalog is always empty, and it
    // would keep passing if a later change populated the array and dropped the slice. Pin the exported
    // cap the handler actually applies instead.
    expect(SUGGEST_SKILLS_CAP).toBe(15);
    expect(out.trigger).toBeUndefined();
    expect(out.note).toMatch(/no addable standalone skills matched/i);
    expect(out.note).toMatch(/search_plugins/i);
  });

  it("proactive: trigger echoed back when supplied, and the note tells the model to stay silent", async () => {
    const h = makeSkillsHandler({
      mountedSkills: [],
      mountedPluginNames: [],
      suggestSkillsEnabled: true,
      proactiveSkillSuggestEnabled: true,
    });
    const out = parseText(await callTool(h, "suggest_skills", { trigger: "proactive" }));
    expect(out.trigger).toBe("proactive");
    expect(out.note).toMatch(/continue silently/i);
  });

  it("proactive: user_asked trigger gets the user-facing (not silent) note", async () => {
    const h = makeSkillsHandler({
      mountedSkills: [],
      mountedPluginNames: [],
      suggestSkillsEnabled: true,
      proactiveSkillSuggestEnabled: true,
    });
    const out = parseText(await callTool(h, "suggest_skills", { trigger: "user_asked" }));
    expect(out.trigger).toBe("user_asked");
    expect(out.note).toMatch(/tell the user nothing new was found/i);
  });

  it("calling suggest_skills when the gate is off is rejected (tool truly doesn't exist)", async () => {
    const h = makeSkillsHandler({
      mountedSkills: [],
      mountedPluginNames: [],
      suggestSkillsEnabled: false,
      proactiveSkillSuggestEnabled: false,
    });
    const out: any = await callTool(h, "suggest_skills", {});
    expect(out.error).toBeDefined();
  });
});

describe("makeSkillsHandler — protocol scaffolding", () => {
  it("initialize returns a well-formed capabilities envelope", async () => {
    const h = makeSkillsHandler({
      mountedSkills: [],
      mountedPluginNames: [],
      suggestSkillsEnabled: true,
      proactiveSkillSuggestEnabled: false,
    });
    const out: any = await h("skills", { method: "initialize", params: { protocolVersion: "2025-06-18" } });
    expect(out.result.serverInfo.name).toBe("skills");
    expect(out.result.protocolVersion).toBe("2025-06-18");
  });

  it("onCall observability hook fires for every tools/call", async () => {
    const calls: Array<[string, unknown]> = [];
    const h = makeSkillsHandler({
      mountedSkills: [],
      mountedPluginNames: [],
      suggestSkillsEnabled: true,
      proactiveSkillSuggestEnabled: false,
      onCall: (name, args) => calls.push([name, args]),
    });
    await callTool(h, "list_skills", { context_label: "x" });
    expect(calls).toEqual([["list_skills", { context_label: "x" }]]);
  });
});
