import { describe, it, expect } from "vitest";
import { expandExpectDenied } from "../src/assert.js";

// `expect_denied` is expanded into `egress_denied` assertions OUTSIDE evaluate(), and that expansion
// was duplicated in execute.ts and cli.ts. Both copies reported a plain "expected <host> to be denied"
// when the egress channel had produced nothing at all — which is how a tier whose bash could reach no
// host looked identical to a tier that simply denied the one you asked about. One helper, so the two
// call sites cannot drift again.
describe("expect_denied → egress_denied expansion", () => {
  const deny = [{ host: "evil.com", decision: "deny" as const }];

  it("passes when the proxy actually recorded a deny for the host", () => {
    const [r] = expandExpectDenied(["evil.com"], deny, false);
    expect(r.pass).toBe(true);
  });

  it("fails plainly when the proxy saw traffic but not a deny for this host", () => {
    const allow = [{ host: "api.anthropic.com", decision: "allow" as const }];
    const [r] = expandExpectDenied(["evil.com"], allow, false);
    expect(r.pass).toBe(false);
    expect(r.message).toContain("expected evil.com to be denied");
    expect(r.message).not.toContain("no egress decisions");
  });

  it("says the evidence channel is empty when NOTHING was recorded — not just 'expected denied'", () => {
    // The distinction that matters: "your host wasn't denied" vs "nothing reached the proxy at all".
    const [r] = expandExpectDenied(["evil.com"], [], false);
    expect(r.pass).toBe(false);
    expect(r.message).toContain("no egress decisions");
  });

  it("reports evidence-unavailable when the log is known absent, matching evaluate()'s wording", () => {
    const [r] = expandExpectDenied(["evil.com"], [], true);
    expect(r.pass).toBe(false);
    expect(r.message).toContain("evidence unavailable");
  });
});
