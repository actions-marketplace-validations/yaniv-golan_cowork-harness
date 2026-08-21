import { describe, it, expect } from "vitest";
import { extractAsarGateIds } from "../src/sync/cowork-sync.js";
import { diffBaselines, formatDiffLines } from "../src/sync/baseline-diff.js";

/**
 * `provenance.asarGateIds` — the field that makes a gate-membership change NAMEABLE.
 *
 * `provenance.fcache` carries two aggregates and a timestamp, so `featureCount: 271 → 278` says seven
 * arrived and nothing says which; a count-neutral swap says nothing at all; and because the fcache
 * refetches on its own schedule (3.7–20.8 min observed) a delta between two baselines is a net over days
 * of server rollout rather than a fact about the Desktop release. This list is a pure function of the
 * shipped bundle, so its diff is attributable, reproducible by anyone, and directly readable.
 *
 * The cases below are written so each CAN fail. Two of them exist because an earlier draft of this test
 * plan could not:
 *   - the filtering case: an implementation that keeps only "interesting" entries passes every
 *     naive case, and the risk was named in the plan with no test behind it.
 *   - the sortedness case: every real gate id is a canonical array index, so JS enumerates them
 *     numerically no matter the insertion order — a key-permutation test passes with `.sort()` deleted.
 *     Only an id above 2^32-1 makes sortedness observable.
 */

const filesOf = (...texts: string[]) => new Map(texts.map((t, i) => [`chunk-${i}.js`, t]));

describe("extractAsarGateIds — what it keeps", () => {
  it("extracts quoted gate ids across every quote style the bundle emits", () => {
    // Minifiers emit all three; anchoring on backticks alone under-reported a real gate delta before.
    const ids = extractAsarGateIds(filesOf('a("66187241")', "b('123929380')", "c(`1143815894`)"));
    expect(ids).toEqual(["66187241", "123929380", "1143815894"]);
  });

  it("sorts NUMERICALLY, and the input order is deliberately the reverse", () => {
    // The ids appear in the bundle in DESCENDING order, so appearance order and sorted order differ.
    // Written the other way round the case passes with `.sort()` deleted — the collector is a Set of
    // strings, which preserves insertion order — and the assertion measures nothing. Mutation-verified:
    // removing the sort fails this case and only this case.
    const ids = extractAsarGateIds(filesOf('y("1000000000");x("999999999")'));
    expect(ids).toEqual(["999999999", "1000000000"]);
  });

  it("keeps an id regardless of gate state — the filtering mutation", () => {
    // An implementation that narrowed to on/served/pinned entries would still pass every case above.
    // These three ids are indistinguishable in the bundle; nothing here says on/off/pinned, and that is
    // precisely the point: the bundle records a REFERENCE, and the field must not editorialise.
    // 1129419822 is `enableToolSearchAuto`, DARK — absent from a standard fcache by design. Dropping
    // ids the local fcache lacks is the specific mistake that would make this list account-shaped.
    const ids = extractAsarGateIds(filesOf('gate("1129419822");gate("2614807392");gate("66187241")'));
    expect(ids).toContain("1129419822");
    expect(ids).toContain("2614807392");
    expect(ids).toHaveLength(3);
  });
});

describe("extractAsarGateIds — what it rejects, and why", () => {
  it("rejects bare (unquoted) numbers", () => {
    // Gate ids are passed as STRING literals. Scanning bare numbers drowns 8 real ids in 2205 unrelated
    // numeric tokens, measured on the 1.34493.1 bundle.
    expect(extractAsarGateIds(filesOf("const t=1755123456; setTimeout(f,66187241)"))).toEqual([]);
  });

  it("rejects leading-zero strings and out-of-range lengths", () => {
    // Every one of the 278 live fcache ids is 8-10 digits with no leading zero, so this is the id space
    // rather than a taste call. `0123456789` and `00000000` are real literals in the shipped bundle.
    const ids = extractAsarGateIds(filesOf('a("0123456789");b("00000000");c("10000");d("12345678901234")'));
    expect(ids).toEqual([]);
  });

  it("rejects an id at or above 2^32 — and that is what proves the sort is real", () => {
    // Below 2^32 an id is a canonical array index, so JS enumerates numerically whatever the insertion
    // order; sortedness is unobservable there. This id is NOT an array index, so an implementation that
    // dropped `.sort()` and relied on enumeration order would expose itself — except it never reaches
    // the array at all, because the range filter rejects it first. Both halves are asserted.
    expect(extractAsarGateIds(filesOf('a("4294967296")'))).toEqual([]);
    expect(extractAsarGateIds(filesOf('a("4293378213")'))).toEqual(["4293378213"]); // max live id, kept
  });

  it("dedupes across chunks and returns a stable order", () => {
    const a = extractAsarGateIds(filesOf('x("66187241")', 'y("1143815894")', 'z("66187241")'));
    const b = extractAsarGateIds(filesOf('z("66187241")', 'y("1143815894")', 'x("66187241")'));
    expect(a).toEqual(["66187241", "1143815894"]);
    expect(a).toEqual(b);
  });

  it("returns [] on an empty bundle rather than throwing", () => {
    expect(extractAsarGateIds(new Map())).toEqual([]);
  });
});

describe("the diff names the delta", () => {
  const withIds = (ids: string[]) => ({ provenance: { asarGateIds: ids } });

  it("renders added and removed ids by name, not as a count", () => {
    const lines = formatDiffLines(diffBaselines(withIds(["66187241", "235864698"]) as never, withIds(["66187241", "40173473"]) as never));
    expect(lines.join("\n")).toContain("40173473");
  });

  it("renders the FIRST introduction — the differ recurses to the leaf", () => {
    // Verified by execution, not assumed: `provenance` exists in every base, so diffBaselines recurses
    // and emits a per-leaf `added` here. An earlier draft asserted the opposite and would have shipped a
    // renderer that never fired.
    const d = diffBaselines(
      { provenance: { asarFingerprint: "x" } } as never,
      { provenance: { asarFingerprint: "x", asarGateIds: ["66187241"] } } as never,
    );
    expect(d.some((e) => e.path === "provenance.asarGateIds" && e.kind === "added")).toBe(true);
  });
});
