import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { AGENT_IMAGE_DEFAULT, resolveAgentImage, resolveContainerRuntime } from "../src/runtime/agent-image.js";

// The agent image ref and the container runtime were each resolved by a duplicated
// `process.env.X ?? "default"` expression at 7 and 10 call sites respectively. Duplication of a DEFAULT
// is a slow leak: the default and the override semantics can drift apart one site at a time, and nothing
// fails when they do. One definition ⇒ every spawn path, probe, and doctor check agrees by construction.

describe("resolveAgentImage", () => {
  it("defaults to the unqualified local tag", () => {
    // Deliberately NOT a ghcr.io ref: README documents building this tag locally, and resolving a
    // registry ref here would bypass that supported path.
    expect(resolveAgentImage({})).toBe("cowork-agent-base:2");
    expect(AGENT_IMAGE_DEFAULT).toBe("cowork-agent-base:2");
  });

  it("honours COWORK_AGENT_IMAGE", () => {
    expect(resolveAgentImage({ COWORK_AGENT_IMAGE: "cowork-agent-full:2" })).toBe("cowork-agent-full:2");
  });

  it("treats an empty or whitespace override as unset", () => {
    // `??` passes "" straight through, so `COWORK_AGENT_IMAGE=` in a .env or a shell export produced an
    // empty image ref and every container invocation failed with an opaque runtime error instead of
    // falling back to the default.
    expect(resolveAgentImage({ COWORK_AGENT_IMAGE: "" })).toBe(AGENT_IMAGE_DEFAULT);
    expect(resolveAgentImage({ COWORK_AGENT_IMAGE: "   " })).toBe(AGENT_IMAGE_DEFAULT);
  });
});

describe("resolveContainerRuntime", () => {
  it("defaults to docker", () => {
    expect(resolveContainerRuntime({})).toBe("docker");
  });

  it("honours COWORK_CONTAINER_RUNTIME", () => {
    expect(resolveContainerRuntime({ COWORK_CONTAINER_RUNTIME: "podman" })).toBe("podman");
  });

  it("treats an empty or whitespace override as unset", () => {
    expect(resolveContainerRuntime({ COWORK_CONTAINER_RUNTIME: "" })).toBe("docker");
    expect(resolveContainerRuntime({ COWORK_CONTAINER_RUNTIME: "  " })).toBe("docker");
  });
});

function srcFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...srcFiles(abs));
    else if (name.endsWith(".ts")) out.push(abs);
  }
  return out;
}

describe("single-source guard", () => {
  const RESOLVER = join("src", "runtime", "agent-image.ts");

  it("reads COWORK_AGENT_IMAGE and COWORK_CONTAINER_RUNTIME only in the resolver", () => {
    // Structural, because there is no behavioural test that would catch a re-introduced literal: a copy
    // with the old `??` semantics passes every existing test while silently reviving the empty-string bug.
    const offenders = srcFiles("src")
      .filter((f) => f !== RESOLVER)
      .filter((f) => /process\.env\.COWORK_(AGENT_IMAGE|CONTAINER_RUNTIME)\b/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});
