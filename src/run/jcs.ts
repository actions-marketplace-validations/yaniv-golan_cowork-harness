/**
 * JCS-style canonical JSON serialization, for the skill-hash format epoch.
 *
 * WHY: `JSON.stringify(JSON.parse(x))` normalizes whitespace but NOT key order, so reordering keys in a
 * plugin manifest — semantically identical, zero behavioral change — re-stales every cassette that hashes
 * it. That is the same flapping the `version` carve-out exists to prevent, reached through another door.
 * It also bakes V8's property-order semantics (insertion order, integer-like keys hoisted) into an on-disk
 * format.
 *
 * SCOPE — read this before claiming conformance. This is **JCS-STYLE**, not RFC 8785 conformance, and the
 * difference is deliberate:
 *
 *   - Key ordering, string escaping and number serialization follow the RFC (all three defer to the
 *     ECMAScript algorithms, which `JSON.stringify` already implements for a single scalar).
 *   - Strict I-JSON *rejection* is NOT implemented. RFC 8785 requires rejecting duplicate property names
 *     and lone surrogates; both are already collapsed by `JSON.parse` before a canonicalizer can see them
 *     (`JSON.parse('{"a":1,"a":2}')` is `{a:2}`), so detecting them needs a duplicate-aware tokenizer or a
 *     new dependency. The goal here is DETERMINISM for realistic manifests — same logical document, same
 *     bytes — not interoperable signing of arbitrary input. A manifest with duplicate keys still hashes
 *     deterministically; it just hashes the value `JSON.parse` kept.
 *
 * Never describe this as RFC 8785 conformance. If these digests ever become a signing or interop surface,
 * that trade has to be revisited with a real tokenizer.
 *
 * The ONE rejection that IS implemented is non-finite numbers — see `JcsCanonicalizationError`.
 */

/** Thrown when a value cannot be canonicalized. MUST NOT be conflated with a `JSON.parse` failure: a
 *  parse failure means "not JSON, hash the raw bytes", while this means "parseable but not canonicalizable",
 *  which has to surface as a read error. Falling back to raw bytes here would silently restore the
 *  `version` field the manifest transform exists to strip. */
export class JcsCanonicalizationError extends Error {
  constructor(reason: string, path: string) {
    super(`cannot canonicalize ${path || "$"}: ${reason}`);
    this.name = "JcsCanonicalizationError";
  }
}

/**
 * Serialize a parsed JSON value to canonical bytes.
 *
 * Emits object members **directly from the sorted key list**. Do not "sort into a temporary object and
 * stringify it": rebuilding an object re-hoists integer-like keys, so `["10","2","name"]` comes back out
 * as `2,10,name` — which is half the defect this function exists to fix.
 *
 * @throws JcsCanonicalizationError on a non-finite number, or a value JSON cannot represent.
 */
export function jcsSerialize(value: unknown, path = "$"): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";

    case "number":
      // JCS defers to ECMAScript `Number::toString`, which is exactly what `JSON.stringify` emits for a
      // finite number — so this is the RFC rule, not an approximation of it.
      if (!Number.isFinite(value)) {
        // `JSON.stringify(Infinity)` is "null", which would make {"x":1e400} and {"x":null} hash
        // IDENTICALLY despite different values — a staleness false-negative. Refuse instead.
        throw new JcsCanonicalizationError(`non-finite number (${String(value)})`, path);
      }
      return JSON.stringify(value);

    case "string":
      // ECMAScript escaping (minimal escapes, \u for control characters) — again the RFC's own rule.
      return JSON.stringify(value);

    case "object": {
      if (Array.isArray(value)) {
        // Arrays are ORDER-BEARING: element order is data, never normalized. Only object KEYS sort.
        return `[${value.map((v, i) => jcsSerialize(v, `${path}[${i}]`)).join(",")}]`;
      }
      const obj = value as Record<string, unknown>;
      // Default string sort IS UTF-16 code-unit order, which is what JCS specifies.
      const keys = Object.keys(obj).sort();
      const members = keys.map((k) => `${JSON.stringify(k)}:${jcsSerialize(obj[k], `${path}.${k}`)}`);
      return `{${members.join(",")}}`;
    }

    default:
      // `undefined`, functions, symbols, bigints. Unreachable from `JSON.parse` output, so this is a
      // guard against a caller handing us a hand-built object — loud rather than silently skipped, since
      // `JSON.stringify` would DROP an undefined member and change the digest invisibly.
      throw new JcsCanonicalizationError(`unsupported value type '${typeof value}'`, path);
  }
}
