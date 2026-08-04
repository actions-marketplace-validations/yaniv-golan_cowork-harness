import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { scanHostInventory, KNOWN_COWORK_SERVERS, KNOWN_BUILTIN_AGENTS, HOST_INVENTORY_CLS, DEFAULT_SCAN_PATTERNS } from "../src/scan.js";
import { makeSkillsHandler } from "../src/hostloop/skills-handler.js";
import { makePluginsHandler } from "../src/hostloop/plugins-handler.js";

// A cassette recorded at a host-inheriting tier freezes the recording MACHINE's inventory into its init and
// command-registry events. One such fixture shipped publicly carrying 18 personal MCP server names, the
// account org, and the host's agent roster. The text scanner could not see it: an unconnected MCP server
// declares no tools, so no `mcp__*` token is written and a `grep mcp__` reads clean — the inventory lives in
// NAME fields. These pin the structural replacement.

const init = (over: Record<string, unknown>) => ({ type: "system", subtype: "init", ...over });

describe("scanHostInventory — foreign MCP servers (the axis that caught the real leak)", () => {
  it("flags a server name outside the harness's own set", () => {
    const f = scanHostInventory(init({ mcp_servers: [{ name: "plaud", status: "pending" }] }), "events[0]", []);
    expect(f.map((x) => x.sample)).toEqual(["plaud"]);
    expect(f[0].cls).toBe(HOST_INVENTORY_CLS);
    expect(f[0].where).toContain("mcp_servers[].name");
  });

  it("flags an UNCONNECTED server — the shipped leak's servers were all pending/needs-auth/failed", () => {
    const f = scanHostInventory(
      init({
        mcp_servers: [
          { name: "claude.ai Gmail", status: "needs-auth" },
          { name: "paper", status: "failed" },
        ],
      }),
      "events[0]",
      [],
    );
    expect(f.map((x) => x.sample).sort()).toEqual(["claude.ai Gmail", "paper"]);
  });

  it("does NOT flag the harness's own servers", () => {
    const f = scanHostInventory(
      init({ mcp_servers: [...KNOWN_COWORK_SERVERS].map((name) => ({ name, status: "connected" })) }),
      "events[0]",
      [],
    );
    expect(f).toEqual([]);
  });

  // Field scoping: only NAME fields are read. Descriptions are unbounded free text with no clean predicate,
  // so a foreign name mentioned in prose is out of scope BY DESIGN. Non-vacuous only as a pair with the
  // positive above — on its own it would pass against a guard that reads nothing at all.
  it("does NOT flag a foreign name that appears only inside a description field", () => {
    const f = scanHostInventory(
      {
        type: "control_response",
        response: { response: { commands: [{ name: "x", description: "connect plaud and claude.ai Gmail here" }] } },
      },
      "events[0]",
      [],
    );
    expect(f).toEqual([]);
  });
});

describe("scanHostInventory — remaining axes", () => {
  it("flags a prefixed tool naming a foreign server (defence-in-depth)", () => {
    const f = scanHostInventory(init({ tools: ["Bash", "mcp__plaud__get_transcript", "mcp__skills__list_skills"] }), "events[0]", []);
    expect(f.map((x) => x.sample)).toEqual(["plaud"]);
  });

  it("flags each operator-identity key on the account block, and no others", () => {
    const f = scanHostInventory(
      {
        response: {
          response: {
            account: { email: "a@b.c", organization: "acme", subscriptionType: "max", apiProvider: "firstParty", tokenSource: "X" },
          },
        },
      },
      "events[0]",
      [],
    );
    expect(f.map((x) => x.sample).sort()).toEqual(["email", "organization", "subscriptionType"]);
  });

  it("does NOT flag a clean account block (tokenSource + apiProvider only)", () => {
    const f = scanHostInventory(
      { response: { response: { account: { tokenSource: "CLAUDE_CODE_OAUTH_TOKEN", apiProvider: "firstParty" } } } },
      "events[0]",
      [],
    );
    expect(f).toEqual([]);
  });

  it("flags an agent outside the built-in roster, accepting both string and {name} shapes", () => {
    const strs = scanHostInventory(init({ agents: ["Plan", "codex:codex-rescue"] }), "events[0]", []);
    expect(strs.map((x) => x.sample)).toEqual(["codex:codex-rescue"]);
    const objs = scanHostInventory(
      { response: { response: { agents: [{ name: "Plan" }, { name: "hookify:conversation-analyzer" }] } } },
      "events[0]",
      [],
    );
    expect(objs.map((x) => x.sample)).toEqual(["hookify:conversation-analyzer"]);
  });

  it("does NOT flag the built-in agent roster", () => {
    expect(scanHostInventory(init({ agents: [...KNOWN_BUILTIN_AGENTS] }), "events[0]", [])).toEqual([]);
  });

  it("finds a declaration nested below the event root (registry responses sit two levels down)", () => {
    const f = scanHostInventory({ a: { b: { c: init({ mcp_servers: [{ name: "plaud" }] }) } } }, "events[0]", []);
    expect(f.map((x) => x.sample)).toEqual(["plaud"]);
  });
});

describe("scanHostInventory — allow scoping", () => {
  it("a class-scoped allow suppresses it; a differently-scoped allow does not", () => {
    const ev = init({ mcp_servers: [{ name: "plaud" }] });
    expect(scanHostInventory(ev, "events[0]", [{ cls: HOST_INVENTORY_CLS, re: /plaud/ }])).toEqual([]);
    expect(scanHostInventory(ev, "events[0]", [{ cls: "path", re: /plaud/ }])).toHaveLength(1);
  });

  it("the allow must match the WHOLE name, not a substring", () => {
    const ev = init({ mcp_servers: [{ name: "claude.ai Gmail" }] });
    expect(scanHostInventory(ev, "events[0]", [{ cls: HOST_INVENTORY_CLS, re: /Gmail/ }])).toHaveLength(1);
    expect(scanHostInventory(ev, "events[0]", [{ cls: HOST_INVENTORY_CLS, re: /claude\.ai Gmail/ }])).toEqual([]);
  });
});

describe("host-inventory — drift guards", () => {
  // KNOWN_COWORK_SERVERS is a literal in scan.ts to avoid a scan->hostloop dependency. This asserts it
  // against what the handlers actually report, so the two cannot drift apart silently.
  it("KNOWN_COWORK_SERVERS contains every server name the handlers report via initialize", async () => {
    const handlers = [
      makeSkillsHandler({ mountedSkills: [], mountedPluginNames: [], suggestSkillsEnabled: true, proactiveSkillSuggestEnabled: false }),
      makePluginsHandler({ mountedPlugins: [] }),
    ];
    for (const h of handlers) {
      // McpHandler is (server, jsonrpcRequest) => McpResult
      const res: any = await h(undefined as never, { method: "initialize", params: {} } as never);
      const name = res?.result?.serverInfo?.name;
      expect(typeof name).toBe("string");
      expect(KNOWN_COWORK_SERVERS.has(name)).toBe(true);
    }
  });

  // The `cls` enum is hand-maintained in THREE places and had already rotted before this class existed:
  // `binary` was emitted by the artifact path but missing from the schema, so a JSON consumer validating
  // that output would reject it. An empty grep proves nothing here — assert the actual containment.
  it("every emitted cls literal is present in schema/verify-cassettes.json and SPEC.md", () => {
    const root = resolve(__dirname, "..");
    const schema = readFileSync(join(root, "schema/verify-cassettes.json"), "utf8");
    const spec = readFileSync(join(root, "SPEC.md"), "utf8");
    const enumMatch = /"enum":\s*\[([^\]]*)\]/.exec(schema.slice(schema.indexOf('"cls"')));
    const schemaEnum = new Set((enumMatch?.[1] ?? "").split(",").map((s) => s.trim().replace(/^"|"$/g, "")));
    const emitted = [...DEFAULT_SCAN_PATTERNS.map((p) => p.cls), HOST_INVENTORY_CLS, "unscanned", "binary"];
    for (const cls of emitted) {
      expect(schemaEnum.has(cls), `${cls} missing from schema/verify-cassettes.json cls enum`).toBe(true);
      expect(spec.includes(cls), `${cls} missing from SPEC.md's cls union`).toBe(true);
    }
  });
});

// Reachability: the extractor being correct is worthless if the CLI never calls it. This drives the real
// `verify-cassettes` entry point. It FAILS rather than skips when dist/ is absent — a skipIf here would
// green-pass an unbuilt tree, which is the exact vacuous pass this test exists to prevent.
describe("host-inventory — reachable through the verify-cassettes CLI", () => {
  const CLI = resolve(__dirname, "../dist/cli.js");

  it("dist/cli.js exists (build before running this suite)", () => {
    expect(existsSync(CLI), "run `npm run build` — this test must not skip").toBe(true);
  });

  // Derived from a REAL committed cassette rather than hand-built: the loader is strict (scenario.session and
  // friends are required), so a synthesised shape fails as `[error] invalid cassette shape` and exits 3
  // ("could not verify") without ever reaching the privacy scan — a green-looking non-zero for the wrong
  // reason. Copying a known-valid fixture and injecting one foreign server keeps the exit code meaningful.
  const FIXTURES = resolve(__dirname, "../examples/replays");
  const inject = (dir: string, source: string) => {
    const c = JSON.parse(readFileSync(join(FIXTURES, source), "utf8"));
    const i = c.events.findIndex((l: string) => typeof l === "string" && l.includes('"mcp_servers"'));
    expect(i, `${source} should carry an init event with mcp_servers`).toBeGreaterThanOrEqual(0);
    const ev = JSON.parse(c.events[i]);
    ev.mcp_servers = [...(ev.mcp_servers ?? []), { name: "plaud", status: "pending" }];
    c.events[i] = JSON.stringify(ev);
    const p = join(dir, "t.cassette.json");
    writeFileSync(p, JSON.stringify(c, null, 2));
    return p;
  };

  it("a host-inheriting cassette carrying a foreign server FAILS the gate (exit 1, class named)", () => {
    const dir = mkdtempSync(join(tmpdir(), "hostinv-"));
    inject(dir, "hostloop-computer-links.cassette.json"); // hostloop = host-inheriting
    const r = spawnSync(process.execPath, [CLI, "verify-cassettes", dir], { encoding: "utf8" });
    const out = r.stdout + r.stderr;
    expect(out).toContain(HOST_INVENTORY_CLS);
    expect(out).toContain("plaud");
    expect(r.status).toBe(1); // 1 = verified & failed, NOT 3 (could not verify)
  });

  // The tier gate is load-bearing, not cosmetic: `mcp.config` is a documented way to attach an MCP server to
  // a session under test, and the cassette freezes only the session PATH — so the scan cannot tell a declared
  // server from a leaked one. At container the agent is sealed, so it must be exempt or this reds legitimate
  // fixtures. Same injected payload, only the tier differs.
  it("the same payload in a container-tier cassette does NOT fail — a sealed run's server was declared", () => {
    const dir = mkdtempSync(join(tmpdir(), "hostinv-ok-"));
    inject(dir, "example-pdf-skill.cassette.json"); // container = sealed
    const r = spawnSync(process.execPath, [CLI, "verify-cassettes", dir], { encoding: "utf8" });
    expect(r.stdout + r.stderr).not.toContain(HOST_INVENTORY_CLS);
  });
});

// ---------------------------------------------------------------------------------------------------
// Layer B — refuse a host-inheriting record into a repo-visible path, BEFORE the paid spawn.
// Unit-level (hostInventoryPreflight) so these are token-free and cannot accidentally start an agent.
import { hostInventoryPreflight } from "../src/run/cassette.js";
import type { Scenario } from "../src/types.js";

const scn = (fidelity: string): Scenario => ({ name: "t", fidelity, baseline: "latest", prompt: "p" }) as unknown as Scenario;

describe("hostInventoryPreflight — Layer B", () => {
  const repoPath = resolve(__dirname, "../examples/replays/brand-new.cassette.json"); // in-tree, not ignored, absent
  const ignoredPath = resolve(__dirname, "../cassettes/whatever.cassette.json"); // cassettes/ is gitignored
  const outsidePath = join(tmpdir(), "outside.cassette.json");

  it("REFUSES a new repo-visible fixture at protocol", () => {
    const v = hostInventoryPreflight(scn("protocol"), repoPath, false);
    expect(v.kind).toBe("refuse");
    if (v.kind === "refuse") {
      expect(v.message).toContain("protocol");
      expect(v.message).toContain("container"); // names the fix
      expect(v.message).toContain("--allow-host-inventory-fixture"); // names the override
    }
  });

  it("REFUSES at hostloop too", () => {
    expect(hostInventoryPreflight(scn("hostloop"), repoPath, false).kind).toBe("refuse");
  });

  it("allows container tier into the very same path — sealed, nothing to leak", () => {
    expect(hostInventoryPreflight(scn("container"), repoPath, false).kind).toBe("ok");
  });

  it("allows a gitignored in-repo path (the default cassettes/ dir) at protocol", () => {
    expect(hostInventoryPreflight(scn("protocol"), ignoredPath, false).kind).toBe("ok");
  });

  it("allows a path outside any work tree at protocol", () => {
    expect(hostInventoryPreflight(scn("protocol"), outsidePath, false).kind).toBe("ok");
  });

  it("the override flag turns the refusal off", () => {
    expect(hostInventoryPreflight(scn("protocol"), repoPath, true).kind).toBe("ok");
  });

  // An in-place refresh of an EXISTING committed fixture warns instead of refusing. Refusing it would break
  // --rerecord-stale on every host-inheriting fixture, and the predictable result is that the override gets
  // passed by reflex — disabling the guard exactly where it matters. Layer A still hard-gates the result.
  it("WARNS (does not refuse) when re-recording an existing committed fixture in place", () => {
    const existing = resolve(__dirname, "../examples/replays/hostloop-computer-links.cassette.json");
    const v = hostInventoryPreflight(scn("hostloop"), existing, false);
    expect(v.kind).toBe("warn");
    if (v.kind === "warn") expect(v.message).toContain("verify-cassettes");
  });
});
