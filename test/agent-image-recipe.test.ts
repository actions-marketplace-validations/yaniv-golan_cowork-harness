import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

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
