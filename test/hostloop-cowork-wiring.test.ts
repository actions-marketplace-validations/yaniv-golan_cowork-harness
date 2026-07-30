import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hostLoopPresentFilesRoots } from "../src/runtime/hostloop.js";
import type { LaunchPlan, Mount } from "../src/session.js";

// spawnHostLoop itself spawns a real native process + a Docker sidecar (not token-free — see
// runtime-fidelity.test.ts's own note on this), so this file covers the two testable halves of Part 2's
// wiring requirement without spawning anything:
//   1. `hostLoopPresentFilesRoots` — the pure allowlist builder — directly.
//   2. the argv/bundle SEAM it renders through, via a source-grep regression guard (the same technique
//      runtime-fidelity.test.ts already uses for the CLAUDE_PLUGIN_ROOT sentinel removal).

function plan(mounts: Mount[]): LaunchPlan {
  return {
    configDir: "/HOST/CFG",
    mcpConfig: null,
    permissionMode: "default",
    permissionParity: "cowork",
    baseEnv: {},
    mounts,
    pluginDirs: [],
    egressAllow: [],
  };
}

describe("hostLoopPresentFilesRoots", () => {
  it("always includes hostOutputsDir, even with no connected folders", () => {
    expect(hostLoopPresentFilesRoots("/HOST/mnt/outputs", plan([]))).toEqual(["/HOST/mnt/outputs"]);
  });

  it("adds every connected-folder mount's real host path", () => {
    const mounts: Mount[] = [
      { hostPath: "/real/folder-a", mountPath: "folder-a", mode: "rw", kind: "folder" },
      { hostPath: "/real/folder-b", mountPath: "folder-b", mode: "r", kind: "folder" },
    ];
    expect(hostLoopPresentFilesRoots("/HOST/mnt/outputs", plan(mounts))).toEqual(["/HOST/mnt/outputs", "/real/folder-a", "/real/folder-b"]);
  });

  it("excludes non-folder mounts (uploads, plugins) — the deliberately narrower-than-production set", () => {
    const mounts: Mount[] = [
      { hostPath: "/real/upload.txt", mountPath: "uploads/upload.txt", mode: "r", kind: "upload" },
      { hostPath: "/real/plugin-dir", mountPath: "my-plugin", mode: "r", kind: "local-plugin" },
    ];
    expect(hostLoopPresentFilesRoots("/HOST/mnt/outputs", plan(mounts))).toEqual(["/HOST/mnt/outputs"]);
  });
});

describe("spawnHostLoop source wiring (argv/bundle seam — Docker-gated end-to-end, so asserted here as a regression guard)", () => {
  const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "runtime", "hostloop.ts"), "utf8");

  it("registers mcp__cowork__present_files in extraTools (toolset parity with production's alwaysLoad registration)", () => {
    expect(SRC).toMatch(/extraTools:\s*\[[^\]]*"mcp__cowork__present_files"/s);
  });

  it("pre-approves mcp__cowork__present_files in BOTH extraAllowedTools branches (webFetchViaApi on/off) — alwaysLoad alone is not sufficient pre-approval", () => {
    const matches = SRC.match(/"mcp__cowork__present_files"/g) ?? [];
    // 1 in extraTools + 2 in the ternary's two extraAllowedTools branches = 3 occurrences.
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });

  it("combines a cowork-server bundle into the hostloop sdkMcp (McpHandler dispatches by server name)", () => {
    expect(SRC).toMatch(/servers:\s*\["cowork"\]/);
    // Spread conditionally, because `lane: remote` withholds the bundle entirely — a remote Cowork
    // session has no local MCP servers, so present_files must not be served there.
    expect(SRC).toMatch(
      /combineSdkMcp\(workspaceBundle,\s*\.\.\.\(coworkBundle \? \[coworkBundle\] : \[\]\),\s*skillsBundle,\s*pluginsBundle\)/,
    );
  });

  it("builds the cowork handler from makeCoworkHandlerHostLoop, not the container-shaped makeCoworkHandler", () => {
    expect(SRC).toContain("makeCoworkHandlerHostLoop({ allowedRoots: hostLoopPresentFilesRoots(hostOutputsDir, plan) })");
    expect(SRC).not.toContain("makeCoworkHandler(");
  });
});
