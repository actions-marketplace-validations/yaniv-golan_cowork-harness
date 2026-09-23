import { readFileSync } from "node:fs";

/** Frames copied VERBATIM from a live `container` recording of examples/probes/stop-hook-probe.scenario.yaml
 *  (the plugin's Stop hook blocks once with exit 2, then passes with exit 0). Nothing here was hand-typed:
 *  the evaluator is exercised over what the agent actually emits under --include-hook-events. */
export function loadHookFrames(): Array<Record<string, unknown>> {
  return readFileSync("test/fixtures/hook-frames/stop-hook-block.events.jsonl", "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}
