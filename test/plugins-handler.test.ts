import { describe, it, expect } from "vitest";
import { makePluginsHandler } from "../src/hostloop/plugins-handler.js";
import type { MountedPlugin } from "../src/session.js";

// Token-free, filesystem-free coverage for the `plugins` sdk-MCP server (A2): tool inventory/alwaysLoad,
// list_plugins' envelope populated from mounted plugins, and the deterministic (empty-catalog / echo)
// advisory results for search_plugins/suggest_plugin_install.

const PLUGIN_A: MountedPlugin = {
  pluginName: "founder-skills",
  pluginId: "founder-skills@local",
  description: "Startup analysis toolkit",
  skills: [{ name: "founder-skills:deck-review", description: "Reviews pitch decks" }],
};

async function listTools(h: ReturnType<typeof makePluginsHandler>) {
  const out: any = await h("plugins", { method: "tools/list" });
  return out.result.tools as Array<{ name: string; description: string; inputSchema: any; _meta?: any }>;
}

async function callTool(h: ReturnType<typeof makePluginsHandler>, name: string, args: Record<string, unknown> = {}) {
  const out: any = await h("plugins", { method: "tools/call", params: { name, arguments: args } });
  return out;
}

function parseText(out: any): any {
  return JSON.parse(out.result.content[0].text);
}

describe("makePluginsHandler — tool inventory", () => {
  it("declares exactly the 3 tools, all alwaysLoad", async () => {
    const h = makePluginsHandler({ mountedPlugins: [] });
    const tools = await listTools(h);
    expect(tools.map((t) => t.name).sort()).toEqual(["list_plugins", "search_plugins", "suggest_plugin_install"]);
    for (const t of tools) expect(t._meta["anthropic/alwaysLoad"]).toBe(true);
  });

  it("search_plugins requires userIntent; suggest_plugin_install requires contextLabel+plugins", async () => {
    const tools = await listTools(makePluginsHandler({ mountedPlugins: [] }));
    const search = tools.find((t) => t.name === "search_plugins")!;
    expect(search.inputSchema.required).toEqual(["userIntent"]);
    const suggest = tools.find((t) => t.name === "suggest_plugin_install")!;
    expect(suggest.inputSchema.required).toEqual(["contextLabel", "plugins"]);
  });
});

describe("makePluginsHandler — list_plugins", () => {
  it("empty catalog: well-formed envelope with an empty plugins array", async () => {
    const h = makePluginsHandler({ mountedPlugins: [] });
    const out = parseText(await callTool(h, "list_plugins", {}));
    expect(out.plugins).toEqual([]);
  });

  it("populates from mounted plugins, echoing name/id/description/skills", async () => {
    const h = makePluginsHandler({ mountedPlugins: [PLUGIN_A] });
    const out = parseText(await callTool(h, "list_plugins", { context_label: "For your fundraising work" }));
    expect(out.contextLabel).toBe("For your fundraising work");
    expect(out.plugins).toEqual([
      {
        pluginName: "founder-skills",
        pluginId: "founder-skills@local",
        description: "Startup analysis toolkit",
        skills: [{ name: "founder-skills:deck-review", description: "Reviews pitch decks" }],
      },
    ]);
  });

  it("keywords filter over name/description/skills", async () => {
    const h = makePluginsHandler({ mountedPlugins: [PLUGIN_A] });
    const hit = parseText(await callTool(h, "list_plugins", { keywords: ["deck"] }));
    expect(hit.plugins).toHaveLength(1);
    const miss = parseText(await callTool(h, "list_plugins", { keywords: ["nonexistent-topic"] }));
    expect(miss.plugins).toEqual([]);
  });
});

describe("makePluginsHandler — search_plugins / suggest_plugin_install", () => {
  it("search_plugins: deterministic empty-catalog advisory result, echoing the request", async () => {
    const h = makePluginsHandler({ mountedPlugins: [PLUGIN_A] });
    const out = parseText(await callTool(h, "search_plugins", { userIntent: "help me review a deck", keywords: ["deck"] }));
    expect(out.userIntent).toBe("help me review a deck");
    expect(out.keywords).toEqual(["deck"]);
    expect(out.matched_plugins).toEqual([]);
    expect(out.note).toMatch(/live catalog/i);
  });

  it("search_plugins: missing userIntent is a JSON-RPC error, not a crash", async () => {
    const h = makePluginsHandler({ mountedPlugins: [] });
    const out: any = await callTool(h, "search_plugins", {});
    expect(out.error).toBeDefined();
    expect(out.error.message).toMatch(/userIntent/);
  });

  it("suggest_plugin_install: echoes the caller-supplied plugins with a widget-rendered note", async () => {
    const h = makePluginsHandler({ mountedPlugins: [] });
    const plugins = [{ pluginName: "slack", pluginId: "slack@marketplace", description: "Slack integration" }];
    const out = parseText(await callTool(h, "suggest_plugin_install", { contextLabel: "For your team comms", plugins }));
    expect(out.contextLabel).toBe("For your team comms");
    expect(out.plugins).toEqual(plugins);
    expect(out.note).toMatch(/widget rendered above/i);
  });

  it("suggest_plugin_install: a malformed plugin entry is a JSON-RPC error, not a crash", async () => {
    const h = makePluginsHandler({ mountedPlugins: [] });
    const out: any = await callTool(h, "suggest_plugin_install", {
      contextLabel: "x",
      plugins: [{ pluginName: "slack" }], // missing pluginId/description
    });
    expect(out.error).toBeDefined();
  });
});

describe("makePluginsHandler — protocol scaffolding", () => {
  it("initialize returns a well-formed capabilities envelope", async () => {
    const h = makePluginsHandler({ mountedPlugins: [] });
    const out: any = await h("plugins", { method: "initialize", params: { protocolVersion: "2025-06-18" } });
    expect(out.result.serverInfo.name).toBe("plugins");
  });

  it("unknown tool name is a JSON-RPC error", async () => {
    const h = makePluginsHandler({ mountedPlugins: [] });
    const out: any = await callTool(h, "not_a_real_tool", {});
    expect(out.error).toBeDefined();
  });
});
