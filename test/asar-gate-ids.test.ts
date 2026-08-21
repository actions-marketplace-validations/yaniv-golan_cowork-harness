import { describe, it, expect } from "vitest";
import { extractAsarGateIds } from "../src/sync/cowork-sync.js";
import { diffBaselines, formatDiffLines, renderChangelog } from "../src/sync/baseline-diff.js";

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
 *   - the sortedness case: the collector is a `Set<string>`, which preserves INSERTION order for every
 *     key, so the only variation that can catch a deleted `.sort()` is input whose appearance order
 *     differs from its numeric order. (The canonical-array-index rule — numeric enumeration regardless of
 *     insertion order — governs plain OBJECTS, not this collector. An earlier draft cited it here and
 *     drew the wrong conclusion, which is why the 2^32 case below no longer claims to prove the sort.)
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
    // Gate ids are passed as STRING literals. Over the same require-graph input the extractor reads,
    // scanning bare numbers instead yields 1953 numeric tokens on the 1.34493.1 bundle — of which only
    // 8 are live gate ids. (An earlier draft said 2205; that was measured over ALL of `.vite`, a
    // different population than the extractor actually walks.)
    expect(extractAsarGateIds(filesOf("const t=1755123456; setTimeout(f,66187241)"))).toEqual([]);
  });

  it("rejects leading-zero strings and out-of-range lengths, at BOTH bounds", () => {
    // Every one of the 278 live fcache ids is 8-10 digits with no leading zero, so this is the id space
    // rather than a taste call. `0123456789` and `00000000` are real literals in the shipped bundle.
    const ids = extractAsarGateIds(filesOf('a("0123456789");b("00000000");c("10000");d("12345678901234")'));
    expect(ids).toEqual([]);
    // The lower bound needs its OWN adjacent case: with only a 5-digit and a 14-digit sample above,
    // relaxing `< 8` to `< 7` passed every case while admitting a 7-digit token (208 -> 209 on the real
    // bundle). Mutation-verified — an off-by-one at a bound is invisible unless something sits on it.
    expect(extractAsarGateIds(filesOf('a("1234567")'))).toEqual([]); // 7 digits — just below the space
    expect(extractAsarGateIds(filesOf('a("17519066")'))).toEqual(["17519066"]); // 8 — min live id, kept
  });

  it("rejects an id at or above 2^32", () => {
    // Range check ONLY. This case does not prove the sort — mutation-verified, it kills the range check
    // and nothing else. The descending-input case above is what a deleted `.sort()` fails.
    expect(extractAsarGateIds(filesOf('a("4294967296")'))).toEqual([]);
    expect(extractAsarGateIds(filesOf('a("4293378213")'))).toEqual(["4293378213"]); // max live id, kept
  });

  it("requires a CLOSING quote, not just an opening one", () => {
    // Uncovered until an adversarial pass found it: deleting the closing character class from the regex
    // passed all ten cases while inflating the real 1.34493.1 bundle 208 -> 216, admitting numbers out of
    // unterminated or differently-delimited contexts. An id is only an id when its literal is closed.
    expect(extractAsarGateIds(filesOf("a(\"66187241);b('123929380"))).toEqual([]);
    expect(extractAsarGateIds(filesOf('a("66187241")'))).toEqual(["66187241"]);
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
    // Through renderChangelog — that is what reaches the per-field renderer. Asserting through
    // formatDiffLines instead only exercises the pre-existing generic `+[…] -[…]` formatter: measured,
    // deleting the entire renderer block left this file and baseline-diff green at 38/38.
    const out = renderChangelog(diffBaselines(withIds(["66187241", "235864698"]) as never, withIds(["66187241", "40173473"]) as never));
    expect(out).toContain("gate ids referenced by the bundle");
    expect(out).toContain("40173473");
    expect(out).toContain("235864698");
  });

  it("`sync --diff` uses the GENERIC formatter, so the field must read sanely there too", () => {
    // The per-field renderer above is reachable only from `diff --changelog` (cli.ts:4915).
    // `sync --diff` calls formatDiffLines (cli.ts:2958), whose docstring says it carries no known-field
    // prose. Pinning both so a future reader does not assume the nice line appears during a sync.
    const lines = formatDiffLines(diffBaselines(withIds(["66187241"]) as never, withIds(["66187241", "40173473"]) as never));
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

describe("the field actually reaches the committed artifact", () => {
  it("the newest baseline carries a well-formed asarGateIds", async () => {
    // The consumer contract. An adversarial pass showed that deleting the write in `src/cli.ts` left all
    // 5,749 tests byte-identical — nothing observed whether `sync` emitted the field at all. This closes
    // the artifact half of that: shape, sortedness and id-space are asserted on what actually shipped.
    // Honest limit: it catches a deleted write only AFTER the next sync regenerates a baseline without
    // it. The record-time half is covered by the empty-extraction flag in `extractFromAsar`.
    const { loadBaseline } = await import("../src/baseline.js");
    const ids = (loadBaseline("latest") as unknown as { provenance?: { asarGateIds?: unknown } }).provenance?.asarGateIds;
    expect(Array.isArray(ids)).toBe(true);
    const list = ids as string[];
    expect(list.length).toBeGreaterThan(100);
    expect(list.every((i) => /^[1-9]\d{7,9}$/.test(i) && Number(i) < 2 ** 32)).toBe(true);
    expect([...list].sort((a, b) => Number(a) - Number(b))).toEqual(list);
    expect(new Set(list).size).toBe(list.length);
  });
});
