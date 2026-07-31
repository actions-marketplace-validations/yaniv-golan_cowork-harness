import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
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

  // Anchored on the CONSTANT, not the first occurrence of the image name: the surrounding comment
  // legitimately names older tags to explain the history, and a first-match regex would silently read
  // one of those instead of the value actually shipped.
  const tagOf = (s: string) => s.match(/COWORK_PROXY_IMAGE \?\? "cowork-egress-proxy:(\d+)"/)?.[1];

  it("carries the same tag in the sidecar and in doctor", () => {
    expect(tagOf(sidecar), "sidecar's PROXY_IMAGE constant").toBeDefined();
    expect(tagOf(doctor), "doctor's proxyImageName default").toBeDefined();
    expect(tagOf(sidecar)).toBe(tagOf(doctor));
  });

  it("the tag is past :2 — the last one built on the EOL base", () => {
    expect(Number(tagOf(sidecar))).toBeGreaterThanOrEqual(3);
  });

  // THE FORWARD GUARD. Everything above pins the CURRENT bump; this one pins the RULE. Because both
  // ensureProxyImage and doctor reuse an image on tag existence alone, any future edit to
  // Dockerfile.proxy that ships without a tag bump reaches nobody who already built the old tag —
  // silently, exactly the defect the :2 -> :3 move exists to correct. Changing the Dockerfile reds this
  // test; the fix is to bump the tag AND update this digest in the same commit, deliberately.
  it("Dockerfile.proxy has not changed without a matching tag bump", () => {
    const digest = createHash("sha256")
      .update(readFileSync(resolve("docker/Dockerfile.proxy")))
      .digest("hex");
    expect(
      digest,
      "docker/Dockerfile.proxy changed. If the change must reach existing installs (it almost always " +
        "must — they reuse the image on tag existence alone), bump cowork-egress-proxy:<n> in " +
        "src/egress/sidecar.ts AND src/run/doctor.ts, then update this digest in the same commit.",
    ).toBe("f550ba73e1b27f3c761259e72785ee2cc79ef6a4657ce47d1522834e8aa5bd50");
  });
});
