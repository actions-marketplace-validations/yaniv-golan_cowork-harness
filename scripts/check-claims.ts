/**
 * Binary-claim staleness REPORT (not a gate — it always exits 0, deliberately).
 *
 * WHY THIS EXISTS. This repo carries ~60 claims that some behaviour is "binary-verified", each stamped
 * with the agent or app.asar version it was checked against. Exactly two of them are re-derived from the
 * binary by a test (`hook-events-elf-parity`, `subagent-model-precedence-elf`). The rest are prose whose
 * only freshness signal is that stamp — and in 2026-09 two of the claims we happened to look at closely
 * were both WRONG: the hook-event list had been 9-of-33 for eleven agent versions while its comment still
 * read "ELF 2.1.219", and the sub-agent model precedence was stated backwards in three places including
 * two shipped public docs.
 *
 * WHY IT IS NOT A GATE, which matters more than what it prints. A stale stamp is not a wrong claim —
 * plenty of these facts are stable across releases. Hard-failing on staleness would force a version bump
 * every sync, and a bump is satisfiable by editing the digit without re-checking anything. That is the
 * copy-paste-satisfiable guard this repo has already been burned by twice (see the sub-agent append
 * pointer coupling, and `spawn.hooks` claiming to be a drift tripwire it could never be). So this reports
 * the population and its age, and a human decides what to re-verify. Run it as a step in the ASAR ritual.
 *
 * HONEST LIMIT, stated because the failure it addresses already beat a weaker version of it: the stale
 * "ELF 2.1.219" stamp WAS visible in the source for eleven agent versions and nobody acted on it. A
 * report is a weaker instrument than it looks. Its value is making the whole population visible at once
 * and ranked, not making any single line louder.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
/** Shipped surface only. The gitignored internal working-notes directory is deliberately out of scope. */
const SCAN_ROOTS = ["src", "scripts", "docs"]; // "internal" is pruned by SKIP_DIRS below
const SKIP_DIRS = new Set(["internal", "node_modules", "dist"]);

type Stamp = { file: string; line: number; kind: "agent" | "asar"; version: string; text: string };

const cmp = (a: string, b: string): number => {
  const [x, y] = [a.split(".").map(Number), b.split(".").map(Number)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (SKIP_DIRS.has(e)) continue;
    const p = join(dir, e);
    const st = statSync(p, { throwIfNoEntry: false });
    if (st?.isDirectory()) walk(p, out);
    else if (st?.isFile() && /\.(ts|md)$/.test(e)) out.push(p);
  }
  return out;
}

/** `agent 2.1.246`, `ELF 2.1.170`, `CLI 2.1.261` → agent-version stamps.
 *  `app.asar 1.24012.9`, `asar 1.46388.4` → Desktop-version stamps. */
const AGENT_RE = /\b(?:agent(?:\s+ELF)?|ELF|CLI|binary)\s+(\d+\.\d+\.\d+)/g;
const ASAR_RE = /\b(?:app\.asar|asar)\s+(\d+\.\d+\.\d+)/g;

function collect(): Stamp[] {
  const out: Stamp[] = [];
  for (const root of SCAN_ROOTS) {
    const abs = join(ROOT, root);
    if (!statSync(abs, { throwIfNoEntry: false })?.isDirectory()) continue;
    for (const f of walk(abs)) {
      const lines = readFileSync(f, "utf8").split("\n");
      lines.forEach((text, i) => {
        for (const [re, kind] of [
          [AGENT_RE, "agent"],
          [ASAR_RE, "asar"],
        ] as const) {
          re.lastIndex = 0;
          for (let m = re.exec(text); m; m = re.exec(text))
            out.push({ file: relative(ROOT, f), line: i + 1, kind, version: m[1], text: text.trim().slice(0, 88) });
        }
      });
    }
  }
  return out;
}

function pinned(): { agent: string; asar: string } {
  const dir = join(ROOT, "baselines");
  const names = readdirSync(dir)
    .filter((n) => n.startsWith("desktop-") && n.endsWith(".json"))
    .map((n) => n.slice("desktop-".length, -".json".length))
    .sort(cmp);
  const newest = names[names.length - 1];
  const b = JSON.parse(readFileSync(join(dir, `desktop-${newest}.json`), "utf8"));
  return { agent: b.agentBinary?.version ?? b.agentVersion ?? "0.0.0", asar: newest };
}

const pin = pinned();
const stamps = collect();
const stale = stamps.filter((s) => cmp(s.version, s.kind === "agent" ? pin.agent : pin.asar) < 0).sort((a, b) => cmp(a.version, b.version));

console.log(`binary-claim staleness — pinned agent ${pin.agent}, pinned asar ${pin.asar}`);
console.log(
  `${stamps.length} version-stamped claim(s) across ${new Set(stamps.map((s) => s.file)).size} file(s); ${stale.length} behind the pin.\n`,
);
for (const s of stale) console.log(`  ${s.kind.padEnd(5)} ${s.version.padEnd(11)} ${s.file}:${s.line}\n        ${s.text}`);
if (!stale.length) console.log("  (nothing behind the pin)");
console.log(
  `\nREPORT ONLY — exits 0 by design. A stale stamp is not a wrong claim; it is a claim nobody has\n` +
    `re-checked. Re-verify what matters for what you are shipping, and RE-STAMP ONLY WHAT YOU ACTUALLY\n` +
    `RE-READ IN THE BINARY — bumping the digit without re-reading is how the last two defects survived.`,
);
