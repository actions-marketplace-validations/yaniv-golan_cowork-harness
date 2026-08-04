// Generates JSON Schemas for the scenario & session YAML from the zod schemas,
// so any agent/editor can author valid files without reading the TS.
//
//   npm run schema        # regenerate schema/*.schema.json
//
// The committed files in schema/ are guarded by test/schema.test.ts, which calls
// buildSchemas() and fails if they drift from the zod source.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { ScenarioObject, Assertion, VERDICT_MODIFIER_KEYS } from "../src/types.js";
import { SessionConfig } from "../src/session.js";
import { SERVED_HOOK_EVENTS, KNOWN_HOOK_EVENTS } from "../src/agent/session.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SCHEMA_DIR = join(REPO_ROOT, "schema");
/** The bundled linter (`scenario.py`) reads this for its assertion-key list. It lives NEXT TO scenario.py
 *  (not under schema/) because schema/ is not shipped inside the plugin tree — only the skill's scripts dir
 *  is. Writer + the drift-guard test both reference this one constant. */
export const ASSERTION_KEYS_PATH = join(REPO_ROOT, ".claude/skills/cowork-harness/scripts/assertion-keys.json");

/** The authoritative key lists `scenario.py` reads — derived from the Zod schemas (the same source
 *  `assertions --list` reads). Generating them keeps the linter's unknown-key checks from drifting: `keys` is
 *  the `assert:` catalog, `topLevelKeys` the scenario top-level catalog (an earlier hand-maintained copy
 *  drifted and false-flagged the valid `requires_capabilities`). `assertions` is NOT here — it's a hard
 *  error handled by scenario.py's own special-case, so it's intentionally absent from the schema shape.
 *  (`profile` used to have a matching special-case for its now-removed alias; it has none anymore — an
 *  unrecognized `profile:` key falls through to the plain unknown-key rejection like any other typo.) */
export function buildAssertionKeys(): string {
  return (
    JSON.stringify(
      {
        $comment: "GENERATED from the Zod schemas (src/types.ts) by scripts/gen-schema.ts — do not edit; run `npm run schema`.",
        keys: Object.keys(Assertion.shape).sort(),
        // Every valid top-level scenario key, from the ScenarioObject strictObject shape (NOT the `Scenario`
        // preprocess wrapper). scenario.py keeps an embedded fallback parity-tested against this.
        topLevelKeys: Object.keys(ScenarioObject.shape).sort(),
        // The verdict-modifier subset (no-op assertions that suppress a default-fail). scenario.py keeps a
        // hardcoded copy parity-tested against this; see VERDICT_MODIFIER_KEYS in src/types.ts.
        verdictModifierKeys: [...VERDICT_MODIFIER_KEYS].sort(),
        // Hook events. `servedHookEvents` is what THIS harness installs on `initialize`;
        // `knownHookEvents` is every event the agent binary understands. The linter needs both to tell
        // "a real event we don't serve" (a fidelity gap worth warning about) from "a typo" (an error).
        // Generated for the same reason as the key lists above: a hand-copied served-set would stop
        // warning about the very event it was later extended to cover. See SERVED_HOOK_EVENTS in
        // src/agent/session.ts for why the served set is narrower than production's install.
        servedHookEvents: [...SERVED_HOOK_EVENTS].sort(),
        knownHookEvents: [...KNOWN_HOOK_EVENTS].sort(),
      },
      null,
      2,
    ) + "\n"
  );
}

const TARGETS = [
  {
    file: "scenario.schema.json",
    schema: ScenarioObject,
    description: "cowork-harness scenario YAML — prompt + scripted answers + assert:. See docs/scenario.md.",
  },
  {
    file: "session.schema.json",
    schema: SessionConfig,
    description: "cowork-harness session YAML — pre-prompt setup (model, mounts, discovery). See docs/session.md.",
  },
] as const;

/** zod 4's `z.toJSONSchema` lists every `.default()` field in `required` (at EVERY nesting level — the old
 *  `zod-to-json-schema` did not). For an authoring schema a defaulted field is NOT author-required, so strip
 *  defaulted keys from `required` everywhere. Do NOT swap this for `{ io: "input" }`: that drops the same
 *  `required` entries but ALSO strips `additionalProperties:false` from nested objects, silently disabling
 *  the strict-object fail-closed. */
function stripDefaultedRequired(node: unknown): void {
  if (Array.isArray(node)) {
    node.forEach(stripDefaultedRequired);
    return;
  }
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  const props = obj.properties as Record<string, { default?: unknown }> | undefined;
  if (props && Array.isArray(obj.required)) {
    obj.required = (obj.required as string[]).filter((k) => !(props[k] && "default" in props[k]));
    if ((obj.required as string[]).length === 0) delete obj.required;
  }
  for (const v of Object.values(obj)) stripDefaultedRequired(v);
}

/** Mirror `Scenario`'s cross-key rules (src/types.ts `superRefine`) into the published JSON Schema.
 *
 *  A zod refinement has NO JSON Schema representation, so `z.toJSONSchema` silently drops it. Without
 *  this, the loader would reject a scenario that the published schema accepts — and an editor or a CI
 *  step validating against `schema/scenario.schema.json` would green a file that cannot actually run.
 *  Any rule added to that `superRefine` must be added here too; `test/schema.test.ts` validates the
 *  emitted schema with a real validator so a forgotten mirror fails loudly rather than drifting. */
function addScenarioCrossKeyRules(json: Record<string, unknown>): void {
  // `assert` is an ARRAY, and the two keys may live in different entries, so the rule is expressed over
  // the array with `contains` rather than over a single item: reject when SOME entry carries
  // `no_delete_in_outputs` and SOME entry carries `allow_outputs_delete` (one entry carrying both
  // satisfies each `contains`, so that case is covered too).
  // `type: "array"` is required alongside `contains` for ajv STRICT mode (strictTypes) — without it the
  // schema compiles under `strict:false` but throws for a strict consumer. test/schema-ajv.test.ts pins it.
  const someEntryHas = (key: string) => ({
    type: "object",
    required: ["assert"],
    // ajv strict also wants every `required` name declared in `properties` (strictRequired), hence the
    // `{ [key]: {} }` stub — the presence of the key is the whole condition, its value is irrelevant here.
    properties: { assert: { type: "array", contains: { type: "object", required: [key], properties: { [key]: {} } } } },
  });
  json.not = { allOf: [someEntryHas("no_delete_in_outputs"), someEntryHas("allow_outputs_delete")] };
}

/** Build { filename: pretty-printed-JSON } for every schema. Pure; no I/O. */
export function buildSchemas(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const t of TARGETS) {
    const json = z.toJSONSchema(t.schema, { target: "draft-7" }) as Record<string, unknown>;
    stripDefaultedRequired(json);
    if (t.file === "scenario.schema.json") addScenarioCrossKeyRules(json);
    json.description = t.description;
    out[t.file] = JSON.stringify(json, null, 2) + "\n";
  }
  return out;
}

function main(): void {
  mkdirSync(SCHEMA_DIR, { recursive: true });
  const schemas = buildSchemas();
  for (const [file, body] of Object.entries(schemas)) {
    writeFileSync(join(SCHEMA_DIR, file), body);
    process.stdout.write(`wrote schema/${file}\n`);
  }
  writeFileSync(ASSERTION_KEYS_PATH, buildAssertionKeys());
  process.stdout.write(`wrote ${ASSERTION_KEYS_PATH}\n`);
}

// Run only when invoked directly (so the test can import buildSchemas without side effects).
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
