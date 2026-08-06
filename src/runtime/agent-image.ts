/** Single source of truth for WHICH agent image the harness runs and WHICH container runtime runs it.
 *
 *  Both were previously resolved by a duplicated `process.env.X ?? "default"` expression — the image at 7
 *  call sites, the runtime at 10. Duplicating a default is a slow leak: the default value and the override
 *  semantics can drift apart one site at a time, and nothing fails when they do. `test/agent-image.test.ts`
 *  carries a structural guard that these env vars are read nowhere else in `src/`. */

/** The unqualified LOCAL tag the harness runs. Deliberately not a `ghcr.io/...` ref: `README.md`
 *  documents building this tag locally, and resolving a registry ref here would bypass that path. */
export const AGENT_IMAGE_DEFAULT = "cowork-agent-base:2";

/** The container runtime used for the agent image and the egress sidecar. */
export const CONTAINER_RUNTIME_DEFAULT = "docker";

/** An override is honoured only when it carries a non-blank value. `??` alone passes `""` through, so a
 *  bare `COWORK_AGENT_IMAGE=` in a `.env` or a shell export yielded an empty ref and every container
 *  invocation failed with an opaque runtime error rather than falling back to the default. */
function override(value: string | undefined, fallback: string): string {
  return value && value.trim() ? value : fallback;
}

export function resolveAgentImage(env: NodeJS.ProcessEnv = process.env): string {
  return override(env.COWORK_AGENT_IMAGE, AGENT_IMAGE_DEFAULT);
}

export function resolveContainerRuntime(env: NodeJS.ProcessEnv = process.env): string {
  return override(env.COWORK_CONTAINER_RUNTIME, CONTAINER_RUNTIME_DEFAULT);
}
