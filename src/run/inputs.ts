import { existsSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Resolve a CLI target (a file or a directory) to a sorted list of files — the shared file-or-dir helper
 * for `run`, `replay`, and `verify-cassettes`. A directory matches by one or more extensions (run needs
 * both `.yaml` and `.yml`). A missing path or an EMPTY directory returns `{ error, kind }` so the caller
 * fails loud (a vacuous "0 files = pass" is the cardinal false-green this prevents). A single file is
 * returned as-is regardless of extension (the caller asked for that exact file).
 *
 * `kind` DISCRIMINATES the two failure modes, which are NOT interchangeable even though both are errors:
 *   - `not-found`  — the path does not exist. Almost always a typo or a stale path; must stay loud.
 *   - `empty-dir`  — the directory exists but holds no matching file. Legitimately expected in a repo
 *                    that deliberately keeps no cassettes, which is why `verify-cassettes --allow-empty`
 *                    can opt into treating THIS case (and only this case) as a clean pass.
 * Collapsing the two would make `--allow-empty` green a typo'd path — reintroducing exactly the vacuous
 * pass the loud default exists to prevent. Callers that don't care may keep testing `"error" in resolved`
 * and ignore `kind`; the field is additive.
 */
export function resolveInputs(
  target: string,
  exts: string | string[],
): { files: string[]; isDir: boolean } | { error: string; kind: "not-found" | "empty-dir" } {
  if (!existsSync(target)) return { error: `path not found: ${target}`, kind: "not-found" };
  if (!statSync(target).isDirectory()) return { files: [target], isDir: false };
  const list = Array.isArray(exts) ? exts : [exts];
  const files = readdirSync(target)
    .filter((f) => list.some((e) => f.endsWith(e)))
    .sort()
    .map((f) => join(target, f));
  if (files.length === 0)
    return {
      error: `no ${list.join("/")} files under ${target} — nothing to do (loud non-zero, not a vacuous pass)`,
      kind: "empty-dir",
    };
  return { files, isDir: true };
}
