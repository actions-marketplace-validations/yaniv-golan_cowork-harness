import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { ghcrRefFor } from "../src/run/doctor.js";

// Structural guard on the agent image RECIPE. `docker/Dockerfile.agent` has no COPY/ADD — every byte of
// the image comes from the base image plus apt and pip — so image contents drift with nothing in this
// repo changing. That makes "same recipe ⇒ same bytes" false, and it is the precondition for ever
// pinning the published digest: a pin over a floating base is a pin over a moving target.

const dockerfile = () => readFileSync("docker/Dockerfile.agent", "utf8");

describe("docker/Dockerfile.agent", () => {
  it("has no COPY/ADD, so the base image is the only lever on reproducibility", () => {
    // If this ever fails, the reasoning above needs revisiting — build context would then contribute
    // bytes too, and pinning the base alone would no longer be the whole story.
    expect(dockerfile()).not.toMatch(/^\s*(COPY|ADD)\s/m);
  });

  it("pins the base image by digest", () => {
    // The digest is the multi-arch INDEX digest (what `docker buildx imagetools inspect ubuntu:22.04
    // --format '{{.Manifest.Digest}}'` prints); `--platform` then selects the arm64 manifest from it.
    // A per-arch arm64 manifest digest also works. An amd64 manifest digest fails loudly at build time
    // ("no match for platform"), never silently.
    expect(dockerfile()).toMatch(/^FROM --platform=linux\/arm64 ubuntu:22\.04@sha256:[0-9a-f]{64}$/m);
  });

  it("does not repurpose VM_IMAGE_BUILD as a build counter", () => {
    // VM_IMAGE_BUILD mirrors an env var the real Cowork rootfs sets — it is fidelity data, not our
    // build clock. Overloading it would corrupt a fidelity signal to carry release metadata.
    expect(dockerfile()).toMatch(/^ENV VM_IMAGE_BUILD=2$/m);
  });
});

describe("docker/agent-image.json", () => {
  const manifest = () => JSON.parse(readFileSync("docker/agent-image.json", "utf8"));

  it("carries a positive integer revision", () => {
    // The image's own build clock, deliberately NOT the harness version: `:2-<version>` co-tags encode a
    // version that is not the image's identity, and re-publishing at an existing version would repoint a
    // tag that a pin depends on.
    const r = manifest().revision;
    expect(Number.isInteger(r)).toBe(true);
    expect(r).toBeGreaterThan(0);
  });

  it("keys variants by the FULL local ref, matching ghcrRefFor's map exactly", () => {
    // A pin looked up by `image.split(":")[0]` would match `:probe`, `:latest`, and any future `:3`, and
    // would miss a fully-qualified `ghcr.io/...` ref. Keying by full ref and cross-checking against
    // doctor's published-image map keeps the two tables from drifting apart.
    const keys = Object.keys(manifest().variants).sort();
    expect(keys).toEqual(["cowork-agent-base:2", "cowork-agent-full:2"]);
    for (const k of keys) expect(ghcrRefFor(k)).not.toBeNull();
  });

  it("stores each digest as null or a well-formed manifest digest", () => {
    for (const [name, spec] of Object.entries(manifest().variants) as [string, { digest: string | null }][]) {
      const d = spec.digest;
      expect(d === null || /^sha256:[0-9a-f]{64}$/.test(d), `${name}: ${String(d)}`).toBe(true);
    }
  });
});
