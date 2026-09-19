// Regenerates the committed structured-surface snapshot.
//
//   npm run gen:surface
//
// Writes test/fixtures/surface-baseline.json from the CURRENT repo state: schema/*.json field
// paths/enums, action.yml's inputs + outputs, and the documented COWORK_* env-var set (see
// scripts/lib/surface.ts for exactly what's covered and what's deliberately not).
//
// Run this whenever one of those surfaces changes intentionally, then review the diff — especially
// any removal or type/enum change, which pre-1.0 is still allowed to ship but must be a conscious
// decision, not silent drift. test/surface-contract.test.ts fails until the snapshot is regenerated
// to match the live surface.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { format, resolveConfig } from "prettier";
import { computeSurface } from "./lib/surface.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const BASELINE_PATH = join(REPO_ROOT, "test/fixtures/surface-baseline.json");

async function main(): Promise<void> {
  const surface = computeSurface();
  // Formatted with the repo's own prettier config, not raw JSON.stringify. `stringify` puts every array
  // element on its own line while the committed file keeps short arrays inline, so a regen used to reflow
  // ~460 untouched lines around whatever actually changed. Nothing broke — surface-contract.test.ts
  // compares parsed data — but a 468-line diff is one nobody reads closely, and this snapshot exists
  // precisely so a surface change gets read closely. The formatting is now part of the output.
  // `resolveConfig` explicitly: `format({ filepath })` infers only the PARSER from the extension, not the
  // repo's .prettierrc, so without this the output is formatted at prettier's default 80-column width and
  // still reflows every array the committed 140-column file keeps inline — the exact churn this fixes.
  const prettierConfig = await resolveConfig(BASELINE_PATH);
  const json = await format(JSON.stringify(surface, null, 2), { ...prettierConfig, filepath: BASELINE_PATH });
  writeFileSync(BASELINE_PATH, json);
  process.stdout.write("wrote test/fixtures/surface-baseline.json\n");
}

// Run only when invoked directly (so a test can import computeSurface/BASELINE_PATH without side effects).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
