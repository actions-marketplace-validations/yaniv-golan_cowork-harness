// T-D1 — `folderPrefixMap[].from` is a HOST PATH and must be visible to both privacy layers.
//
// `buildRecordTimeFolderPrefixMap` persists the record-time connected-folder host paths into
// `folderPrefixMap[].from`. Neither `scanCassette` nor `redactCassette` looked at that field, so a
// committed cassette could carry `/Users/<name>/...` while `verify-cassettes` reported `ok:true` and
// `privacyScanned:true` — both documented privacy layers reporting clean over a real leak.
//
// THE TRAP THIS FILE EXISTS TO AVOID: there are TWO `scanCassette` call sites, and only one of them
// exercises the projection.
//
//   cassette.ts ~:5640  VALID cassette   -> scanCassette(rc.cassette)        <- the whole Cassette
//   cassette.ts ~:5623  MALFORMED-but-   -> scanCassette(scanOnly.scannable) <- readCassetteForScan's
//                       readable                                                hand-written projection
//
// `Cassette` is structurally assignable to `ScannableCassette`, so adding the field to the interface fixes
// the VALID path for free — a test that only uses a valid fixture passes with half the fix missing, and
// malformed-but-readable cassettes stay unscanned for this exact leak. Both paths are asserted below.

import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCassetteForScan, scanCassette, redactCassette, type Cassette } from "../src/run/cassette.js";
import { DEFAULT_SCAN_PATTERNS } from "../src/scan.js";

const HOST_PATH = "/Users/somebody/code/private-project";

/** Minimal cassette carrying a host path in EXACTLY ONE place: folderPrefixMap[0].from. */
function cassetteWithOnlyFolderPrefixLeak(): Record<string, unknown> {
  return {
    $schema: "https://example.invalid/cassette.v12.json",
    generator: "test",
    cassetteVersion: 12,
    scenario: { name: "t", prompt: "hello", session: "./s.yaml", assert: [], fidelity: "container" },
    events: [JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "nothing to see" }] } })],
    effectiveFidelity: "container",
    folderPrefixMap: [{ from: HOST_PATH, mount: "private-project" }],
  };
}

describe("T-D1 · folderPrefixMap[].from reaches both privacy layers", () => {
  it("(a) VALID path — a cassette whose only host path is folderPrefixMap[].from is flagged", () => {
    // The valid lane passes the whole Cassette object to scanCassette.
    const c = cassetteWithOnlyFolderPrefixLeak() as unknown as Cassette;
    const findings = scanCassette(c, []);
    const paths = findings.filter((f) => f.cls === "path");
    expect(paths.length, `expected a 'path' finding for ${HOST_PATH}; got ${JSON.stringify(findings)}`).toBeGreaterThan(0);
    expect(JSON.stringify(paths)).toContain("/Users/somebody");
  });

  it("(b) MALFORMED path — the scan projection carries folderPrefixMap, and the field is still scanned", () => {
    // A document that fails SHAPE validation but has a readable transcript goes through
    // readCassetteForScan. This is the half a valid-only fixture cannot reach.
    const malformed = cassetteWithOnlyFolderPrefixLeak();
    delete (malformed as { cassetteVersion?: unknown }).cassetteVersion; // break the shape, keep events readable
    (malformed as { scenario: unknown }).scenario = { prompt: "hello" }; // drop required scenario keys

    const dir = mkdtempSync(join(tmpdir(), "d1-malformed-"));
    const file = join(dir, "broken.cassette.json");
    writeFileSync(file, JSON.stringify(malformed));

    const read = readCassetteForScan(file);
    expect("scannable" in read, `projection failed to read a malformed-but-readable cassette: ${JSON.stringify(read)}`).toBe(true);
    if (!("scannable" in read)) return;

    // The projection must CARRY the field — this is the assertion that fails when only the interface
    // is widened and readCassetteForScan is left alone.
    expect(
      (read.scannable as { folderPrefixMap?: unknown }).folderPrefixMap,
      "readCassetteForScan dropped folderPrefixMap — the malformed lane is still blind to this leak",
    ).toBeDefined();

    const findings = scanCassette(read.scannable, []);
    expect(findings.filter((f) => f.cls === "path").length, `expected a 'path' finding via the projection`).toBeGreaterThan(0);
  });

  it("(c) redaction rewrites folderPrefixMap[].from", () => {
    const c = cassetteWithOnlyFolderPrefixLeak() as unknown as Cassette;
    const redacted = redactCassette(c, { patterns: [{ re: /\/Users\/[^/]+/g, label: "host" }], keyNames: [] });
    const from = (redacted as unknown as { folderPrefixMap?: { from: string }[] }).folderPrefixMap?.[0]?.from ?? "";
    expect(from, "redactCassette left the host path in folderPrefixMap[].from").not.toContain("/Users/somebody");
  });

  it("(d) no committed example cassette carries a host-root path anywhere in its serialized form", () => {
    // Reuse the SHIPPED detector rather than hand-rolling a subset: an earlier hand-written predicate
    // omitted /root, /private/var and /var/folders and invented an unsupported Windows form.
    const pathPattern = DEFAULT_SCAN_PATTERNS.find((p) => p.cls === "path");
    expect(pathPattern, "DEFAULT_SCAN_PATTERNS no longer exposes a 'path' class — update this test").toBeDefined();

    const files = ["examples/replays/example-pdf-skill.cassette.json", "examples/replays/example-multiselect-gate.cassette.json"];
    for (const f of files) {
      const raw = readFileSync(f, "utf8");
      const re = new RegExp(
        pathPattern!.re.source,
        pathPattern!.re.flags.includes("g") ? pathPattern!.re.flags : pathPattern!.re.flags + "g",
      );
      const hits = [...raw.matchAll(re)].map((m) => m[0]);
      expect(hits, `${f} carries host path(s): ${hits.slice(0, 3).join(", ")}`).toEqual([]);
    }
  });
});
