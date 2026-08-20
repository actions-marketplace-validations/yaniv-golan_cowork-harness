import { describe, it, expect } from "vitest";
import { jcsSerialize, JcsCanonicalizationError } from "../src/run/jcs.js";

describe("jcsSerialize — canonical output", () => {
  it("sorts object keys by UTF-16 code unit", () => {
    expect(jcsSerialize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    // Code-unit order, NOT locale and NOT numeric: "10" < "2" because "1" < "2".
    expect(jcsSerialize({ "2": "x", "10": "y" })).toBe('{"10":"y","2":"x"}');
  });

  it("does NOT re-hoist integer-like keys — the bug a temp object reintroduces", () => {
    // `Object.keys` puts integer-like keys first in NUMERIC order, so a "sort into a fresh object then
    // JSON.stringify" implementation emits {"2":…,"10":…} — the opposite of code-unit order. Emitting
    // straight from the sorted key list is the whole reason this function exists rather than a one-liner.
    const input = { "10": "a", "2": "b", name: "c" };
    const viaTempObject = JSON.stringify(
      Object.fromEntries(
        Object.keys(input)
          .sort()
          .map((k) => [k, input[k as keyof typeof input]]),
      ),
    );
    expect(viaTempObject).toBe('{"2":"b","10":"a","name":"c"}'); // the WRONG answer, pinned so the trap is visible
    expect(jcsSerialize(input)).toBe('{"10":"a","2":"b","name":"c"}'); // the right one
    expect(jcsSerialize(input)).not.toBe(viaTempObject);
  });

  it("is insensitive to key insertion order — the defect being fixed", () => {
    const a = JSON.parse('{"name":"p","skills":"./s","description":"d"}');
    const b = JSON.parse('{"description":"d","skills":"./s","name":"p"}');
    expect(jcsSerialize(a)).toBe(jcsSerialize(b));
    // ...and the current (pre-epoch) transform is NOT, which is why the epoch is needed at all.
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it("sorts keys RECURSIVELY, not just at the top level", () => {
    // Real manifests are unsorted at nested paths (`$.hooks.SessionStart[0]`), so a shallow implementation
    // would report a false "already canonical" for exactly the manifests that matter.
    const nested = { a: { z: 1, y: 2 }, hooks: { SessionStart: [{ b: 1, a: 2 }] } };
    expect(jcsSerialize(nested)).toBe('{"a":{"y":2,"z":1},"hooks":{"SessionStart":[{"a":2,"b":1}]}}');
  });

  it("preserves array order — element order is data, only object keys sort", () => {
    expect(jcsSerialize(["c", "a", "b"])).toBe('["c","a","b"]');
    expect(jcsSerialize({ keywords: ["z", "a"] })).toBe('{"keywords":["z","a"]}');
  });

  it("strips insignificant whitespace", () => {
    expect(jcsSerialize(JSON.parse('{ "a" :  1 ,\n"b":\t2 }'))).toBe('{"a":1,"b":2}');
  });

  it("handles the scalar leaves", () => {
    expect(jcsSerialize(null)).toBe("null");
    expect(jcsSerialize(true)).toBe("true");
    expect(jcsSerialize(false)).toBe("false");
    expect(jcsSerialize(0)).toBe("0");
    expect(jcsSerialize(-0)).toBe("0"); // ES Number::toString — negative zero serializes as "0"
    expect(jcsSerialize(1.5)).toBe("1.5");
    expect(jcsSerialize(1e21)).toBe("1e+21"); // exponent form, per ES
  });

  it("escapes strings by the ECMAScript rules, including non-BMP and control chars", () => {
    expect(jcsSerialize("a\nb")).toBe('"a\\nb"');
    expect(jcsSerialize("\u0001")).toBe('"\\u0001"'); // escape, not a raw control byte in source
    expect(jcsSerialize("é😀")).toBe('"é😀"'); // no gratuitous \u escaping of printable non-ASCII
    expect(jcsSerialize({ ключ: 1 })).toBe('{"ключ":1}');
  });

  it("sorts non-ASCII keys by code unit, not by locale", () => {
    // localeCompare would order these differently; JCS mandates code-unit order.
    const out = jcsSerialize({ ä: 1, z: 2 });
    expect(out).toBe('{"z":2,"ä":1}'); // "z" (0x7A) < "ä" (0xE4)
  });
});

describe("jcsSerialize — what it REFUSES, and why refusing beats falling back", () => {
  it("rejects non-finite numbers, which would otherwise COLLIDE with null", () => {
    // `JSON.parse('{"x":1e400}')` yields Infinity, and `JSON.stringify` renders that as `null` — so
    // {"x":1e400} and {"x":null} would produce byte-identical digests despite different values. That is a
    // staleness FALSE-NEGATIVE: a real change that no longer re-stales.
    const overflow = JSON.parse('{"x":1e400}');
    expect(overflow.x).toBe(Infinity);
    expect(JSON.stringify(overflow)).toBe(JSON.stringify({ x: null })); // the collision, pinned
    expect(() => jcsSerialize(overflow)).toThrow(JcsCanonicalizationError);
    expect(() => jcsSerialize(NaN)).toThrow(/non-finite/);
    expect(() => jcsSerialize(-Infinity)).toThrow(/non-finite/);
  });

  it("names the path of the offending value", () => {
    expect(() => jcsSerialize({ a: { b: [1, NaN] } })).toThrow(/\$\.a\.b\[1\]/);
  });

  it("rejects values JSON cannot represent rather than silently dropping them", () => {
    // `JSON.stringify({a: undefined})` is `{}` — the member vanishes and the digest changes invisibly.
    expect(() => jcsSerialize({ a: undefined })).toThrow(JcsCanonicalizationError);
    expect(() => jcsSerialize({ a: () => 1 })).toThrow(/unsupported value type/);
  });
});

describe("jcsSerialize — documented NON-conformance (JCS-style, not RFC 8785)", () => {
  it("inherits JSON.parse's last-wins duplicate-key semantics, DETERMINISTICALLY", () => {
    // RFC 8785 requires rejecting duplicate property names. `JSON.parse` has already collapsed them before
    // we see the value, so detecting this needs a tokenizer. What matters for a staleness gate is that the
    // result is deterministic and documented — not that it matches the RFC. Pinned so the trade is
    // explicit rather than discovered.
    const dup = JSON.parse('{"a":1,"a":2}');
    expect(dup).toEqual({ a: 2 });
    expect(jcsSerialize(dup)).toBe('{"a":2}');
    expect(jcsSerialize(JSON.parse('{"a":1,"a":2}'))).toBe(jcsSerialize(JSON.parse('{"a":2}')));
  });
});
