import type { McpHandler, McpResult } from "./workspace-handler.js";
import type { MountedSkill } from "../run/skill-metadata.js";

/**
 * The `skills` sdk-MCP server, driver-side — models the Desktop-side skill-discovery surface a real
 * cowork-lane session (container/hostloop) declares alongside `workspace`/`cowork`: `list_skills`
 * (always) and `suggest_skills` (gated). Binary-verified (2026-07-24 confirmation pass, app.asar
 * 1.24012.1 — see the A2 confirmation doc's §4/§5/§6): the tool inventory, both inputSchemas, both gate
 * ids (`suggestSkillsEnabled:245679952`, `proactiveSkillSuggestEnabled:1598976391`) and their effect on
 * the tool set, and the output envelope's field set + branch structure (the `note` variants, the
 * `.slice(0,15)` cap on `suggest_skills.resolved_skills`) are ALL pinned to the extracted asar. One
 * exception: `list_skills.resolved_skills`'s PER-ITEM shape was opaque in the extraction (confirmation
 * doc §6) — we mirror `suggest_skills`'s confirmed `{name,description,skill_id,is_user_created}` item
 * shape here, so treat that per-item shape as inferred, not binary-verified. The tool
 * DESCRIPTION strings below are a faithful prose reconstruction assembled from the confirmed semantic
 * fragments the extraction recovered (the routing rule, the fallback clause, the base-vs-proactive
 * split, the `search_plugins` nudge) — the recon recovered the meaning/structure but not a literal wire
 * byte-string, so treat the exact wording as harness prose, not a captured constant (the same caveat
 * `cowork-handler.ts` documents for `present_files`, for the analogous reason).
 *
 * Every tool is `_meta:{"anthropic/alwaysLoad":true}` — real Cowork reports these in the `system/init`
 * `tools` array from turn one (see `docs/fidelity-gaps.md`), not behind a ToolSearch `select:` round-trip.
 *
 * `resolved_skills`/`installed_plugins` are populated from the session's actually-mounted skills/plugins
 * (deterministic, run-derived — `listMountedSkills`/`mountedPluginsFromPlan`), never a live catalog call:
 * no network, no side effect, matching the harness's token-free posture for every other SDK-MCP stub.
 * `suggest_skills`'s `resolved_skills` is a deliberate exception — it always returns empty, because the
 * *addable* (not-yet-installed) catalog is Anthropic's live skill library, which this harness does not
 * model; an empty catalog with an honest `note` is the faithful stub (spec §6/§7), not a bug.
 */

/** The 5 skill/plugin-discovery SDK-MCP tool names — declared as `extraTools`/`extraAllowedTools` on
 *  BOTH container (runtime/container.ts) and hostloop (runtime/hostloop.ts), so they are both
 *  REGISTERED and pre-approved exactly like `mcp__cowork__present_files` (an off-registry first call
 *  trips the cowork-parity permissive-auto-allow guard — confirmed live before that tool was added). */
export const SKILLS_PLUGINS_TOOL_NAMES = [
  "mcp__skills__list_skills",
  "mcp__skills__suggest_skills",
  "mcp__plugins__list_plugins",
  "mcp__plugins__search_plugins",
  "mcp__plugins__suggest_plugin_install",
];

/** Production's cap on `suggest_skills.resolved_skills`. Exported (and pinned by a test) so the cap
 *  survives a future change that actually populates the array — today the slice is a no-op because the
 *  addable catalog is out-of-band and always empty, which would make an inline `.slice(0, 15)` and any
 *  test of its result silently unguarded. */
export const SUGGEST_SKILLS_CAP = 15;

const LIST_SKILLS_DESC_WITH_FALLBACK =
  "List the skills installed in this session. Omit skill_names to show every installed skill; pass " +
  "skill_names to highlight specific ones, or keywords to filter by topic. Call this with no arguments " +
  "when the user asks what skills they have or to show their skills. If nothing matches, fall back to " +
  "suggest_skills.";
const LIST_SKILLS_DESC_NO_FALLBACK =
  "List the skills installed in this session. Omit skill_names to show every installed skill; pass " +
  "skill_names to highlight specific ones, or keywords to filter by topic. Call this with no arguments " +
  "when the user asks what skills they have or to show their skills.";

const SUGGEST_SKILLS_DESC_BASE =
  "Suggest skills the user could add but has not yet installed. Call this when the user asks for skill " +
  "recommendations, or when list_skills returned no matches. When search_plugins is available, also " +
  "call it with the same keywords.";
const SUGGEST_SKILLS_DESC_PROACTIVE =
  "Suggest skills the user could add but has not yet installed — either because they asked, or " +
  "proactively when the conversation suggests a skill they don't have would help. Set trigger to " +
  '"user_asked" when the user explicitly asked for suggestions, or "proactive" when you are raising ' +
  "this on your own initiative. Call this when the user asks for skill recommendations, when " +
  "list_skills returned no matches, or proactively when relevant. When search_plugins is available, " +
  "also call it with the same keywords.";

type JsonSchema = Record<string, unknown>;

function suggestSkillsInputSchema(withTrigger: boolean): JsonSchema {
  return {
    type: "object",
    properties: {
      keywords: { type: "array", items: { type: "string" } },
      context_label: { type: "string" },
      ...(withTrigger ? { trigger: { type: "string", enum: ["user_asked", "proactive"] } } : {}),
    },
    required: [],
  };
}

export interface MakeSkillsHandlerOptions {
  /** This session's staged skills (skills.local + plugin-provided) — see `listMountedSkills`. */
  mountedSkills: MountedSkill[];
  /** Mounted plugin NAME strings — `list_skills`'s `installed_plugins` field. */
  mountedPluginNames: string[];
  /** Gate 245679952 (readGateBool ▸ session knob ▸ default true) — whether `suggest_skills` is declared
   *  at all. */
  suggestSkillsEnabled: boolean;
  /** Gate 1598976391 (readGateBool ▸ session knob ▸ default false) — only consulted when
   *  `suggestSkillsEnabled` is true; swaps `suggest_skills`'s description and adds `trigger`. */
  proactiveSkillSuggestEnabled: boolean;
  /** TEST SEAM — called for every `tools/call`, before dispatch. Deliberately not wired by
   *  container.ts/hostloop.ts (there is no run-telemetry sink for discovery calls today, and the
   *  handlers are pure stubs); it exists so tests can assert dispatch without a spawn. Do not describe
   *  it as run observability until something actually consumes it. */
  onCall?: (name: string, args: Record<string, unknown>) => void;
}

export function makeSkillsHandler(opts: MakeSkillsHandlerOptions): McpHandler {
  const { mountedSkills, mountedPluginNames, suggestSkillsEnabled, onCall } = opts;
  // proactiveSkillSuggestEnabled is only ever consulted once suggestSkillsEnabled is true (spec §5: "only
  // evaluated if the first is on") — guard here so a caller that sets the proactive knob without the base
  // one can't accidentally light up `trigger` on a tool that doesn't exist.
  const proactive = suggestSkillsEnabled && opts.proactiveSkillSuggestEnabled;

  const tools: Array<{ name: string; description: string; inputSchema: JsonSchema; _meta: { "anthropic/alwaysLoad": true } }> = [
    {
      name: "list_skills",
      description: suggestSkillsEnabled ? LIST_SKILLS_DESC_WITH_FALLBACK : LIST_SKILLS_DESC_NO_FALLBACK,
      inputSchema: {
        type: "object",
        properties: {
          skill_names: { type: "array", items: { type: "string" } },
          keywords: { type: "array", items: { type: "string" } },
          context_label: { type: "string" },
        },
        required: [],
      },
      _meta: { "anthropic/alwaysLoad": true },
    },
  ];
  if (suggestSkillsEnabled) {
    tools.push({
      name: "suggest_skills",
      description: proactive ? SUGGEST_SKILLS_DESC_PROACTIVE : SUGGEST_SKILLS_DESC_BASE,
      inputSchema: suggestSkillsInputSchema(proactive),
      _meta: { "anthropic/alwaysLoad": true },
    });
  }

  function callListSkills(args: Record<string, unknown>): McpResult {
    const skillNames = Array.isArray(args.skill_names) ? args.skill_names.filter((s): s is string => typeof s === "string") : undefined;
    const keywords = Array.isArray(args.keywords) ? args.keywords.filter((s): s is string => typeof s === "string") : undefined;
    const contextLabel = typeof args.context_label === "string" ? args.context_label : undefined;

    // keywords is ignored when skill_names is set (spec §4).
    let resolved = mountedSkills;
    if (skillNames && skillNames.length) {
      const want = new Set(skillNames);
      resolved = mountedSkills.filter((s) => want.has(s.name));
    } else if (keywords && keywords.length) {
      const needles = keywords.map((k) => k.toLowerCase());
      resolved = mountedSkills.filter((s) =>
        needles.some((k) => s.name.toLowerCase().includes(k) || (s.description ?? "").toLowerCase().includes(k)),
      );
    }

    const note =
      resolved.length > 0
        ? "Skills widget rendered above with the listed skills. Skip re-listing them in text."
        : mountedPluginNames.length > 0
          ? "No slash-menu skills matched — the widget did not render. The user has these plugins installed: " +
            `${mountedPluginNames.join(", ")}. Call list_skills again with no skill_names to see everything installed.`
          : "No installed skills matched — the widget did not render.";

    return {
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              resolved_skills: resolved.map((s) => ({
                name: s.name,
                description: s.description,
                skill_id: s.name,
                is_user_created: s.isUserCreated,
              })),
              installed_plugins: mountedPluginNames,
              context_label: contextLabel,
              request_skill_names: skillNames ?? [],
              request_keywords: keywords ?? [],
              note,
            }),
          },
        ],
      },
    };
  }

  function callSuggestSkills(args: Record<string, unknown>): McpResult {
    const contextLabel = typeof args.context_label === "string" ? args.context_label : undefined;
    const trigger = proactive && (args.trigger === "user_asked" || args.trigger === "proactive") ? args.trigger : undefined;
    // The addable (not-yet-installed) catalog is out-of-band (Anthropic's live skill library) — always
    // empty here, capped at SUGGEST_SKILLS_CAP like production for shape-fidelity even though the slice is
    // a no-op while the array is empty. The cap is exported and pinned by a test so that a later change
    // which POPULATES this array cannot quietly drop the production cap.
    const resolvedSkills: Array<{ name: string; description?: string; skill_id: string; is_user_created: boolean }> = [];
    const note =
      trigger === "proactive"
        ? "No addable standalone skills matched — the widget did not render. Continue silently; do not " + "mention this to the user."
        : "No addable standalone skills matched — the widget did not render. Call search_plugins with the " +
          "same keywords; call list_skills instead if the user has relevant installed skills; otherwise " +
          "tell the user nothing new was found.";

    return {
      result: {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              resolved_skills: resolvedSkills.slice(0, SUGGEST_SKILLS_CAP),
              context_label: contextLabel,
              ...(trigger ? { trigger } : {}),
              note,
            }),
          },
        ],
      },
    };
  }

  return (_server, jr): McpResult => {
    const method = jr.method;
    if (method === "initialize")
      return {
        result: {
          protocolVersion: (jr.params && jr.params.protocolVersion) || "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "skills", version: "1.0.0" },
        },
      };
    if (method === "tools/list") return { result: { tools } };
    if (method === "tools/call") {
      const name = jr.params?.name;
      const args = (jr.params?.arguments ?? {}) as Record<string, unknown>;
      onCall?.(name, args);
      if (name === "list_skills") return callListSkills(args);
      if (name === "suggest_skills" && suggestSkillsEnabled) return callSuggestSkills(args);
      return { error: { code: -32602, message: `unknown tool: ${name}` } };
    }
    return { result: {} }; // ping / notifications
  };
}
