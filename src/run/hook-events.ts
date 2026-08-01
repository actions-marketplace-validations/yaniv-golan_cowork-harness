/**
 * Mount-time warning for a plugin that declares a hook event this harness does not serve.
 *
 * WHY THIS EXISTS. The harness installs `PreToolUse` only (see `SERVED_HOOK_EVENTS`), while real Cowork
 * installs three event types and the agent binary understands nine. Before this check, a plugin
 * declaring `UserPromptSubmit` mounted, ran, and produced no comment of any kind — a consumer had to
 * grep the harness's own compiled output to discover the surface was unmodelled. That is the failure
 * this closes: not "the hook doesn't work", but "nothing told you the harness has no opinion about it".
 *
 * WHY IT IS ALSO HERE AND NOT ONLY IN `lint-skill`. The static linter is opt-in and many scenarios never
 * run it. A run that mounts the plugin is the one moment we know the declaration exists AND that someone
 * is about to depend on it, so the warning belongs on that path too.
 *
 * WHAT IT SAYS, AND WHY THAT WORDING. A plugin's own hooks DO fire here — live-verified 2026-08-01 at
 * BOTH `container` and `hostloop` with a fixture plugin declaring SessionStart / UserPromptSubmit /
 * PostToolUse: all three executed. The agent binary loads them through the `--plugin-dir` channel, which
 * the harness neither serves nor blocks. So this notice must NOT say "your hook won't run" — that would
 * be false and would send an author rewriting working code.
 *
 * What is actually missing is twofold, and both are about the HARNESS, not the plugin: there is no
 * assertion key for any event but PreToolUse (so a scenario cannot gate on it), and the harness does not
 * install the additional hooks real Cowork installs for that event (so their effects are absent).
 *
 * PLACEMENT MATTERS AND IS SILENT. The binary reads `<plugin>/hooks/hooks.json`. The identical file at
 * the plugin ROOT fires nothing, with no error anywhere — which is exactly how a probe (and a consumer)
 * can conclude "hooks don't work in Cowork" from a misplaced file. Flagged separately.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { KNOWN_HOOK_EVENTS, SERVED_HOOK_EVENTS, type HookEvent } from "../agent/session.js";

/** Depth-limited `hooks.json` search. A plugin root holds them at the root or one level down
 *  (`skills/<name>/hooks.json`, `.claude-plugin/hooks.json`); walking deeper would wander into
 *  `node_modules`-shaped trees for no gain. */
function findHooksFiles(root: string, depth = 2): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string, d: number): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // unreadable dir is not a lint failure — the mount itself will report a real problem
    }
    for (const e of entries) {
      const p = join(dir, e);
      let isDir = false;
      try {
        isDir = statSync(p).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        if (d > 0 && e !== "node_modules" && !e.startsWith(".git")) walk(p, d - 1);
      } else if (e === "hooks.json") out.push(p);
    }
  };
  walk(root, depth);
  return out;
}

/** Event names declared by a `hooks.json`, tolerating both the `{"hooks": {...}}` (settings.json) shape
 *  and a bare `{...}` event map. Returns [] for anything unparseable — a malformed hooks.json is the
 *  static linter's problem, not this warning's. */
export function declaredHookEvents(hooksJsonPath: string): string[] {
  try {
    const doc = JSON.parse(readFileSync(hooksJsonPath, "utf8"));
    if (!doc || typeof doc !== "object") return [];
    const events = doc.hooks && typeof doc.hooks === "object" ? doc.hooks : doc;
    if (!events || typeof events !== "object") return [];
    return Object.keys(events).filter((k) => typeof k === "string");
  } catch {
    return [];
  }
}

/** Emit one `::warning::` per (source, unserved event). Never throws — a warning path that can fail the
 *  run would be worse than the silence it replaces. */
export function warnUnservedHookEvents(pluginRoots: string[], warn: (msg: string) => void): void {
  const served = new Set<string>(SERVED_HOOK_EVENTS);
  const known = new Set<string>(KNOWN_HOOK_EVENTS as readonly string[]);
  const seen = new Set<string>(); // dedupe: the same event across N mounted plugins warns once per source
  for (const root of pluginRoots) {
    for (const f of findHooksFiles(root)) {
      // Placement check, before the per-event loop: a root-level `hooks.json` fires NOTHING, so the
      // events it declares are moot and reporting them would bury the real problem.
      if (!f.endsWith(`${sep}hooks${sep}hooks.json`)) {
        warn(
          `::warning:: [hooks] ${f} is not under a \`hooks/\` directory — the agent reads plugin hooks from ` +
            `\`<plugin>/hooks/hooks.json\`, so this file is silently ignored and NONE of its hooks run. Move it.\n`,
        );
        continue;
      }
      for (const name of declaredHookEvents(f)) {
        if (served.has(name)) continue;
        const key = `${f}::${name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        warn(
          known.has(name as HookEvent)
            ? `::notice:: [hooks] ${f} declares \`${name}\` — it WILL fire (a plugin's own hooks are executed by ` +
                `the agent), but this harness installs only ${[...SERVED_HOOK_EVENTS].join(", ")} itself: there is no ` +
                `assertion key for \`${name}\`, so a scenario cannot gate on it, and the extra \`${name}\` hooks real ` +
                `Cowork installs are not reproduced. Assert the hook's observable effect instead.\n`
            : `::warning:: [hooks] ${f} declares \`${name}\`, which is not a recognized hook event — it is ignored ` +
                `everywhere, so this hook never runs. Check spelling/capitalization.\n`,
        );
      }
    }
  }
}
