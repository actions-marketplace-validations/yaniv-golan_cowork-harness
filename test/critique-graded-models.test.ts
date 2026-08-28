import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGradedModels } from "../src/critique/command";
import { isLiveModelId } from "../src/types";

// The DERIVATION, not the rendering. `readGradedModels` and `isLiveModelId` shipped with zero direct
// coverage: the report tests hand `gradedModels: ["claude-sonnet-5"]` straight into the builders, so
// gutting the <synthetic> filter, the dedup, and the taskRaw/disk contract all left the suite green.

const dirs: string[] = [];
function runDirWith(result: unknown): string {
  const root = mkdtempSync(join(tmpdir(), "critique-models-"));
  dirs.push(root);
  mkdirSync(join(root, "turns", "1"), { recursive: true });
  writeFileSync(join(root, "turns", "1", "result.json"), JSON.stringify(result));
  return root;
}
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe("isLiveModelId", () => {
  it("keeps real model ids and rejects the agent's locally-fabricated markers", () => {
    expect(isLiveModelId("claude-opus-5")).toBe(true);
    expect(isLiveModelId("<synthetic>")).toBe(false);
  });

  it("matches the angle-bracket SHAPE, not the `<` prefix — the two disagree on a malformed marker", () => {
    // src/run/provenance.ts rendered `provenance.model` with the SHAPE rule while the prefix rule was
    // introduced elsewhere. On "<synthetic" (truncated / a future marker) the two disagreed: one report
    // dropped it, the other printed it AS IF IT WERE A MODEL. Both now share this predicate, so this
    // pins the rule they share rather than either caller.
    expect(isLiveModelId("<synthetic")).toBe(true);
    expect(isLiveModelId("<future-marker>")).toBe(false);
  });

  it("does not treat the empty string as a marker (it was live under the predicate this replaced)", () => {
    // scripts/eval-gate.ts collapses its observed-model set and THROWS on heterogeneity, so silently
    // dropping "" would shrink a set of size 2 to 1 and let a gate proceed that used to be refused.
    expect(isLiveModelId("")).toBe(true);
    expect(isLiveModelId(undefined)).toBe(false);
    expect(isLiveModelId(42)).toBe(false);
  });
});

describe("readGradedModels", () => {
  it("filters the agent's markers out of the graded turn's recorded models", () => {
    const dir = runDirWith({ models: ["claude-opus-5", "<synthetic>"] });
    expect(readGradedModels(dir)).toEqual(["claude-opus-5"]);
  });

  it("dedups repeated ids", () => {
    const dir = runDirWith({ models: ["claude-opus-5", "claude-opus-5"] });
    expect(readGradedModels(dir)).toEqual(["claude-opus-5"]);
  });

  it("returns undefined — never [] — when only markers were recorded, so the report says `unknown`", () => {
    expect(readGradedModels(runDirWith({ models: ["<synthetic>"] }))).toBeUndefined();
    expect(readGradedModels(runDirWith({ models: [] }))).toBeUndefined();
    expect(readGradedModels(runDirWith({}))).toBeUndefined();
    expect(readGradedModels(runDirWith({ models: "not-an-array" }))).toBeUndefined();
  });

  it("returns undefined rather than throwing when there is no readable run dir at all", () => {
    expect(readGradedModels(join(tmpdir(), "critique-models-does-not-exist"))).toBeUndefined();
  });

  it("reads the GRADED turn (turns/1), not the reflection turn", () => {
    // critique runs two turns into one dir and turns/2 is the reflection turn's. Reading the wrong one
    // reports the model that graded nothing.
    const dir = runDirWith({ models: ["claude-opus-5"] });
    mkdirSync(join(dir, "turns", "2"), { recursive: true });
    writeFileSync(join(dir, "turns", "2", "result.json"), JSON.stringify({ models: ["claude-haiku-4-5-20251001"] }));
    expect(readGradedModels(dir)).toEqual(["claude-opus-5"]);
  });

  it("honours an ALREADY-READ result — `undefined` means re-read from disk, `null` means read and absent", () => {
    // The two are not interchangeable: `null` must NOT silently fall back to a disk read, or the caller's
    // "I looked and there was nothing" becomes a second, contradictory answer.
    const dir = runDirWith({ models: ["on-disk-model"] });
    expect(readGradedModels(dir, { models: ["passed-in-model"] })).toEqual(["passed-in-model"]);
    expect(readGradedModels(dir, null)).toBeUndefined();
    expect(readGradedModels(dir)).toEqual(["on-disk-model"]);
  });
});
