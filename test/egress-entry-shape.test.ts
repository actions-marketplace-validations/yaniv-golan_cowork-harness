import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The "Reading `egress.log`" bullet in docs/critique.md tells a reader how to tell a PROXY denial
 * from a web_fetch denial inside the same `egress[]` array. That advice holds only while the two
 * emitters keep different record shapes, so pin the shapes — not the prose.
 *
 * Read as source text rather than by executing the emitters: the proxy's deny path needs a live
 * CONNECT socket and the handler's needs a network hop, and neither round-trip bears on the one claim
 * under test (which fields each call site writes).
 */
const SRC = (p: string) => readFileSync(resolve(p), "utf8");

describe("egress record shapes distinguish the two emitters", () => {
  it("only the proxy writes port+reason", () => {
    expect(SRC("src/egress/proxy.ts")).toContain('log(normalizedHost, "deny", { port, reason: "not on allowlist" });');
  });

  it("web_fetch's onEgress writes host+decision ONLY, at every call site", () => {
    const calls = SRC("src/hostloop/workspace-handler.ts").match(/onEgress\?\.\(\{[^}]*\}\)/g) ?? [];
    expect(calls.length).toBeGreaterThan(0); // guard the premise: the regex must actually find them
    for (const c of calls) {
      // Both `{ host, decision }` (ES shorthand) and `{ host: cur.hostname, decision }` occur.
      expect(c).toMatch(/^onEgress\?\.\(\{ host(: [^,]+)?, decision: "(allow|deny)" \}\)$/);
      expect(c).not.toContain("port");
      expect(c).not.toContain("reason");
    }
  });

  it("container web_fetch is host-routed through the same handler, not the sidecar proxy", () => {
    expect(SRC("src/runtime/container.ts")).toMatch(/opts\.webFetchViaApi\s*\?[\s\S]{0,400}makeWorkspaceHandler\(/);
  });
});
