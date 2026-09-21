import { readdirSync, statSync, realpathSync, type Dirent } from "node:fs";
import { join, sep } from "node:path";

// Extracted from package-evidence.ts so the packager and BOTH corpus resolvers (agents, plugin-root
// references) share one walk with one symlink posture. Two copies would be two containment rules.

/** Every file under `references/`, RECURSIVELY, as forward-slash relative paths, sorted. `statSync` (not
 *  the dirent's `isFile()`) so a SYMLINK to a real file is followed and counted — the old dirent filter
 *  silently dropped both symlinks and subdirectories. Cycle-guarded via a visited-realpath set: a symlinked
 *  directory loop would otherwise recurse forever. A dangling link (its `statSync` throws) is skipped, the
 *  same posture as an unreadable file. */
export function listSkillFilesRecursive(root: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // CONTAINMENT. Following symlinks lets a link escape the skill entirely — `references/out -> /anywhere`
  // walked that directory and packaged its file CONTENTS into the evidence document, and
  // `references/up -> <skillDir>` re-packaged SKILL.md as a reference. Both ship material the agent's mount
  // never contained, which is the false-`already-covered` defect this packager exists to close, and the
  // first also puts arbitrary host content into a document sent to a model. The old code ignored symlinks
  // entirely, so this exposure arrived WITH the symlink support — resolve every entry and refuse anything
  // whose real path is not under the references root.
  let rootReal: string | undefined;
  try {
    rootReal = realpathSync(root);
  } catch {
    return out; // no references/ dir at all
  }
  const contained = (full: string): boolean => {
    try {
      const rp = realpathSync(full);
      return rp === rootReal || rp.startsWith(rootReal + sep);
    } catch {
      return false;
    }
  };
  seen.add(rootReal); // else a self-referential link (references/self -> references) duplicates every file
  const walk = (dir: string, prefix: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // no references/ subdir, or unreadable — an empty list is a legitimate answer
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (!contained(full)) continue; // symlink pointing outside references/ — see the containment note above
      let st;
      try {
        st = statSync(full); // follows symlinks, unlike the dirent
      } catch {
        continue; // dangling symlink / vanished entry
      }
      if (st.isDirectory()) {
        let key: string;
        try {
          key = realpathSync(full);
        } catch {
          continue;
        }
        if (seen.has(key)) continue; // symlinked-directory cycle
        seen.add(key);
        walk(full, rel);
      } else if (st.isFile()) {
        // REAL path, never a sanitized one: this string is both the `readFileSync` argument and the
        // git tracked-set key. Neutralizing here made a marker-named file unreadable (ENOENT) and
        // mislabeled it "could not be read" — sanitize at RENDER time instead, see `displayName`.
        out.push(rel);
      }
    }
  };
  walk(root, "");
  return out.sort();
}
