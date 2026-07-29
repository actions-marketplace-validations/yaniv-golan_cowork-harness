import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The proxy image is built ONCE and then reused on tag existence alone (sidecar.ts's
// ensureProxyImage / doctor's image-inspect probe both short-circuit when the tag resolves). A change
// to Dockerfile.proxy therefore reaches nobody who has already built the previous tag -- their stale
// image keeps serving egress and doctor keeps calling it healthy. These two facts must move together.
describe("egress proxy image", () => {
  const dockerfile = readFileSync(resolve("docker/Dockerfile.proxy"), "utf8");
  const sidecar = readFileSync(resolve("src/egress/sidecar.ts"), "utf8");
  const doctor = readFileSync(resolve("src/run/doctor.ts"), "utf8");

  it("builds on a Node line that still receives security patches", () => {
    const base = dockerfile.match(/^FROM\s+node:(\d+)-/m);
    expect(base, "expected a `FROM node:<major>-...` line").toBeTruthy();
    // 20 is EOL (2026-04-30). Raise this floor deliberately, never to silence a red test.
    expect(Number(base![1])).toBeGreaterThanOrEqual(22);
  });

  it("carries the same tag in the sidecar and in doctor", () => {
    const tagOf = (s: string) => s.match(/cowork-egress-proxy:(\d+)/)?.[1];
    expect(tagOf(sidecar)).toBeDefined();
    expect(tagOf(sidecar)).toBe(tagOf(doctor));
  });

  it("the tag is past :2 — the last one built on the EOL base", () => {
    expect(Number(sidecar.match(/cowork-egress-proxy:(\d+)/)![1])).toBeGreaterThanOrEqual(3);
  });
});
