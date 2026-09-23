import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { includeHookEventsFor } from "../src/session.js";

function pluginDir(withHooks: boolean): string {
  const root = mkdtempSync(join(tmpdir(), "cwh-hookplan-"));
  mkdirSync(join(root, ".claude-plugin"), { recursive: true });
  writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "p", version: "0.1.0" }));
  if (withHooks) {
    mkdirSync(join(root, "hooks"), { recursive: true });
    writeFileSync(
      join(root, "hooks", "hooks.json"),
      JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "true" }] }] } }),
    );
  }
  return root;
}

describe("includeHookEventsFor — the flag follows declared hooks, nothing else", () => {
  it("no plugin mounts → false", () => expect(includeHookEventsFor([])).toBe(false));
  it("a plugin without hooks → false (default argv stays byte-identical)", () =>
    expect(includeHookEventsFor([{ kind: "local-plugin", hostPath: pluginDir(false) }])).toBe(false));
  it("a plugin with hooks/hooks.json → true", () =>
    expect(includeHookEventsFor([{ kind: "local-plugin", hostPath: pluginDir(true) }])).toBe(true));
  it("a folder mount with a hooks.json inside is NOT a plugin and does not count", () =>
    expect(includeHookEventsFor([{ kind: "folder", hostPath: pluginDir(true) }])).toBe(false));
});
