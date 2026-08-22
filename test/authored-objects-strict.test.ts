// T-D2 — every AUTHORED object must reject unknown keys, not silently strip them.
//
// `z.object` drops unrecognized keys. For an authored document that means a typo does not fail — it
// changes what you wrote, quietly:
//
//   { from: "/tmp/x", mdoe: "r" }   ->   { from: "/tmp/x", mode: "rw" }
//
// A read-only mount becomes WRITABLE. Same shape in the assertion layer: `path_denied` with a misspelled
// field strips to `{}`, which matches ANY path denial, and the run stays green.
//
// WHY THIS IS A TREE WALK AND NOT A LIST. The count of affected objects went 2 -> 6 -> 10 across three
// hand-written probes, and every one of them undercounted, because each fed a body shape that some other
// object rejected for an unrelated reason (a missing required field), masking the strip. An enumerated
// list is exactly the instrument that produced the wrong answer three times. So: walk the schema.
//
// WHY THE ORACLE IS THE ZOD TREE AND NOT THE GENERATED SCHEMA. `zod-to-json-schema` emits
// `additionalProperties: false` for `z.object` AND `z.strictObject` alike — verified byte-identical
// output before and after the fix. Asserting against `schema/scenario.schema.json` would therefore be a
// test that CANNOT FAIL. The strictness only exists in the zod tree: `_zod.def.catchall.type === "never"`.

import { describe, it, expect } from "vitest";
import { Assertion, AnswerRule } from "../src/types.js";
import { SessionConfig } from "../src/session.js";

type Node = { _zod?: { def?: Record<string, unknown> } };

/** Every object node reachable from `root`, by dotted path — through optional/default/nullable wrappers,
 *  array elements, and union members. Those wrappers are why a top-level shape scan misses `Folder` and
 *  `Project` (both live behind `z.array`). */
function objectNodes(root: unknown, rootName: string): { path: string; strict: boolean }[] {
  const out: { path: string; strict: boolean }[] = [];
  const seen = new Set<unknown>();

  const visit = (node: unknown, path: string): void => {
    if (node === null || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    const def = (node as Node)._zod?.def as Record<string, unknown> | undefined;
    if (!def) return;

    switch (def.type) {
      case "object": {
        const catchall = def.catchall as Node | undefined;
        out.push({ path, strict: catchall?._zod?.def?.type === "never" });
        for (const [k, v] of Object.entries((def.shape ?? {}) as Record<string, unknown>)) visit(v, `${path}.${k}`);
        return;
      }
      case "array":
        return visit(def.element, `${path}[]`);
      case "optional":
      case "default":
      case "nullable":
      case "readonly":
      case "nonoptional":
        return visit(def.innerType, path);
      case "union":
        return (def.options as unknown[] | undefined)?.forEach((o, i) => visit(o, `${path}|${i}`));
      case "record":
        return visit(def.valueType, `${path}{}`);
      case "pipe":
        return visit(def.in, path);
      default:
        return;
    }
  };

  visit(root, rootName);
  return out;
}

const ROOTS: [string, unknown][] = [
  ["Assertion", Assertion],
  ["AnswerRule", AnswerRule],
  ["SessionConfig", SessionConfig],
];

describe("T-D2 · authored objects reject unknown keys", () => {
  it("the walk reaches a sane number of object nodes (never go green over an empty walk)", () => {
    // A walker that silently returns [] would make every assertion below vacuous — the exact class of
    // non-evidence this ticket exists to remove.
    const total = ROOTS.reduce((n, [name, r]) => n + objectNodes(r, name).length, 0);
    expect(total, "the schema walk found almost nothing — it is not traversing").toBeGreaterThan(10);
  });

  it("reaches objects nested behind z.array (the ones hand-written probes missed)", () => {
    const paths = objectNodes(SessionConfig, "SessionConfig").map((n) => n.path);
    // `folders` and `projects` are arrays of objects; a top-level shape scan never descends into them,
    // and `folders[].mode` is where a typo turns a read-only mount writable.
    expect(paths).toContain("SessionConfig.folders[]");
    expect(paths).toContain("SessionConfig.projects[]");
  });

  it("NO authored object anywhere under Assertion / AnswerRule / SessionConfig is non-strict", () => {
    const loose = ROOTS.flatMap(([name, r]) =>
      objectNodes(r, name)
        .filter((n) => !n.strict)
        .map((n) => n.path),
    );
    expect(
      loose,
      `these authored objects silently STRIP unknown keys, so a typo changes what the author wrote instead of failing:\n  ${loose.join("\n  ")}`,
    ).toEqual([]);
  });

  it("the worst case is closed: a typo'd folder mode no longer becomes writable", () => {
    const r = SessionConfig.safeParse({ folders: [{ from: "/tmp/x", mdoe: "r" }] });
    expect(r.success, "a misspelled `mode` was accepted — the mount silently defaults to writable").toBe(false);
    if (!r.success) expect(JSON.stringify(r.error.issues)).toContain("mdoe");
  });

  it("the assertion case is closed: a typo'd matcher no longer matches everything", () => {
    const r = Assertion.safeParse({ path_denied: { tool: "Read", path_mtaches: "/sessions" } });
    expect(r.success, "a misspelled matcher was stripped, leaving an assertion that matches any denial").toBe(false);
  });

  it("well-formed authored documents still parse", () => {
    // Guards against over-tightening: the sweep must reject typos, not legitimate documents.
    expect(SessionConfig.safeParse({ folders: [{ from: "/tmp/x", mode: "r" }] }).success).toBe(true);
    expect(Assertion.safeParse({ path_denied: { tool: "Read", path_matches: "/sessions" } }).success).toBe(true);
    expect(AnswerRule.safeParse({ when_question: ".*", choose: "1" }).success).toBe(true);
  });
});
