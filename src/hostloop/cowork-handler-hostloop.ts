import { lstatSync, realpathSync } from "node:fs";
import { sep } from "node:path";
import type { McpHandler, McpResult } from "./workspace-handler.js";
import { PRESENT_FILES_DESC, PRESENT_FILES_INPUT_SCHEMA, type PresentedFile } from "./cowork-handler.js";

/**
 * The `cowork` sdk-MCP server, HOSTLOOP-shaped — mirrors production's `isHostLoopMode` branch of the
 * real Cowork `present_files` handler (binary-verified: the handler has two branches, a VM branch and an
 * `isHostLoopMode` branch that validates real host paths and passes them through WITHOUT promoting). At
 * hostloop the agent runs NATIVELY on the real host with real filesystem access and NO container/VM
 * boundary between it and the operator's disk — there is nothing to promote INTO, because the agent's cwd already IS the
 * delivery channel (`hostOutputsDir`). So unlike `cowork-handler.ts` (the container-shaped handler,
 * which COPIES a scratchpad file into `mnt/outputs`), this handler never copies anything: it validates
 * that a presented path resolves to somewhere under one of the caller-supplied allowed roots and, on
 * success, passes the SAME path straight back — production's own pass-through contract.
 *
 * Same tool name, input schema, and description as the container handler (imported from
 * `cowork-handler.ts`, not duplicated) — a skill sees an identical `present_files` contract regardless
 * of which tier served it; only the internal promotion behaviour differs, exactly matching production's
 * own container/host-loop split.
 *
 * SECURITY — this handler is the entire safety boundary for `present_files` at this tier. Hostloop has
 * no container/VM around the native file tools (see `src/runtime/hostloop.ts`'s own doc comment); a
 * crafted `file_path` here is a REAL host path, so every one of the following runs on every file before
 * anything is returned to the model:
 *   1. `lstatSync` (does NOT follow symlinks) — a symlink is rejected outright, regardless of where it
 *      points, mirroring the containment-guard precedent in `src/run/artifacts.ts` (its own symlink
 *      rejection, ~lines 142-147).
 *   2. the lstat'd node must be a regular file — a directory, device, FIFO, etc. is rejected.
 *   3. `realpathSync` resolves the path, and the RESOLVED path must stay under one of `allowedRoots`
 *      (also realpath'd) — the same containment pattern as `artifacts.ts`'s own root check (~line 121),
 *      which is what actually stops a crafted `..`-laden path from escaping a nominal root.
 * Any failure takes the whole-call error branch (mirroring the container handler's own "abort the whole
 * call, copy nothing" pre-check) — never a silent per-file skip.
 */
export function makeCoworkHandlerHostLoop(opts: {
  /** Real host directories a presented path must resolve under — the harness's hostloop equivalents of
   *  production's own allowed set (`hostOutputsDir` plus every connected folder's real host mount path;
   *  see `hostLoopPresentFilesRoots` in `src/runtime/hostloop.ts`). */
  allowedRoots: string[];
  onPresent?: (p: PresentedFile) => void;
}): McpHandler {
  const { allowedRoots, onPresent } = opts;

  // Resolved per validation call (not cached at construction time): a root could in principle not exist
  // yet when the handler is built, and this keeps the containment check honest rather than baking in a
  // realpath that could go stale.
  const resolvedRoots = (): string[] =>
    allowedRoots.flatMap((root) => {
      try {
        return [realpathSync(root)];
      } catch {
        return [];
      }
    });

  const isContained = (real: string, rootReal: string): boolean => real === rootReal || real.startsWith(rootReal + sep);

  type Validated = { ok: true; real: string } | { ok: false; error: string };

  const validate = (filePath: string, rootsReal: string[]): Validated => {
    let st;
    try {
      st = lstatSync(filePath);
    } catch (e: any) {
      return { ok: false, error: `not found (${e?.code ?? e?.message ?? String(e)})` };
    }
    // lstat — does NOT follow symlinks, so a symlink is caught here regardless of where it points, BEFORE
    // any realpath resolution runs. A symlink whose target happens to resolve inside an allowed root is
    // still rejected: the guard is on the node the model named, not merely its eventual target.
    if (st.isSymbolicLink()) return { ok: false, error: "path is a symlink" };
    if (!st.isFile()) return { ok: false, error: "not a regular file" };

    let real: string;
    try {
      real = realpathSync(filePath);
    } catch (e: any) {
      return { ok: false, error: `could not resolve path (${e?.message ?? String(e)})` };
    }
    if (!rootsReal.some((r) => isContained(real, r))) return { ok: false, error: "not accessible on the user's computer" };
    return { ok: true, real };
  };

  const tools = [
    {
      name: "present_files",
      description: PRESENT_FILES_DESC,
      inputSchema: PRESENT_FILES_INPUT_SCHEMA,
      // NOT deferred behind ToolSearch — matches the container handler and real Cowork's own
      // `alwaysLoad` registration (F2 in the closure plan): the tool must be visible from the first turn.
      _meta: { "anthropic/alwaysLoad": true },
    },
  ];

  return (_server, jr): McpResult => {
    const method = jr.method;
    if (method === "initialize")
      return {
        result: {
          protocolVersion: (jr.params && jr.params.protocolVersion) || "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "cowork", version: "1.0.0" },
        },
      };
    if (method === "tools/list") return { result: { tools } };
    if (method === "tools/call") {
      const name = jr.params?.name;
      if (name !== "present_files") return { error: { code: -32602, message: `unknown tool: ${name}` } };
      const filesArg = jr.params?.arguments?.files ?? [];

      // A non-array `files` (string, object, ...) must not reach `.map`/iteration below, which would
      // throw a TypeError instead of failing gracefully back to the agent.
      if (!Array.isArray(filesArg)) {
        return { error: { code: -32602, message: "present_files: files must be an array" } };
      }
      const files: { file_path: string }[] = filesArg;

      // Every entry must carry a non-empty string file_path before any path logic runs — otherwise a
      // missing/wrong-typed field reaches `lstatSync` further down and throws instead of failing
      // gracefully back to the agent.
      const malformed = files.some((f) => typeof f.file_path !== "string" || f.file_path === "");
      if (malformed) return { error: { code: -32602, message: "present_files: each file requires a string file_path" } };

      // Whole-call pre-check, mirroring the container handler's own pattern: validate EVERY file before
      // returning anything, so a mixed valid/invalid batch never partially succeeds and a rejected path
      // never falls through to a silent per-file skip.
      const rootsReal = resolvedRoots();
      const rejected = files.filter((f) => !validate(f.file_path, rootsReal).ok);
      if (rejected.length) {
        return {
          error: {
            code: -32602,
            message: `Cannot present ${rejected.length} file(s) — not accessible on the user's computer: ${rejected
              .map((f) => f.file_path)
              .join(", ")}`,
          },
        };
      }

      // Pass-through: no copy, no rename — `to` is always the SAME path as `from`, matching production's
      // host-loop branch exactly (F1). `promoted` is always false — there is nothing to promote at this
      // tier; the validated path IS already the delivery location.
      const content: { type: string; text: string }[] = [];
      for (const { file_path } of files) {
        content.push({ type: "text", text: file_path });
        onPresent?.({ from: file_path, to: file_path, promoted: false });
      }
      return { result: { content } };
    }
    return { result: {} }; // ping / notifications
  };
}
