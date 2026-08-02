import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { recordedGateLabels, stampLabelProvenance, checkLabelProvenance } from "../src/run/cassette.js";

// This repo is pure ESM ("type": "module") — `__dirname` is undefined; derive the repo root from
// `import.meta.url` instead (this file lives at `<repoRoot>/test/label-provenance.test.ts`).
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLE_CASSETTE = join(REPO_ROOT, "examples/replays/example-multiselect-gate.cassette.json");

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// -------------------------------------------------------------------------------------------- //
// recordedGateLabels
// -------------------------------------------------------------------------------------------- //

describe("recordedGateLabels", () => {
  it("extracts labels from a synthetic nested control_response shape", () => {
    const controlOut = [
      JSON.stringify({
        type: "control_response",
        response: {
          response: {
            updatedInput: {
              questions: [{ options: [{ label: "Auth" }, { label: "Billing" }] }],
            },
          },
        },
      }),
    ];
    expect(recordedGateLabels(controlOut)).toEqual(["Auth", "Billing"]);
  });

  // The real cassette pins the ACTUAL nesting depth this function relies on. A synthetic-only test
  // would keep passing even if the implementation assumed the wrong path (e.g. missing the doubled
  // `response.response`) — that class of bug only shows up against a real recorded payload.
  it("extracts labels from the real example-multiselect-gate cassette's controlOut", () => {
    const cassette = JSON.parse(readFileSync(EXAMPLE_CASSETTE, "utf8")) as {
      controlOut?: (string | object)[];
    };
    const labels = recordedGateLabels(cassette.controlOut);
    expect(labels).toEqual(["Auth", "Billing", "Audit"]);
  });

  it("deduplicates repeated labels across entries", () => {
    const controlOut = [
      JSON.stringify({
        response: { response: { updatedInput: { questions: [{ options: [{ label: "Auth" }] }] } } },
      }),
      JSON.stringify({
        response: { response: { updatedInput: { questions: [{ options: [{ label: "Auth" }, { label: "Billing" }] }] } } },
      }),
    ];
    expect(recordedGateLabels(controlOut)).toEqual(["Auth", "Billing"]);
  });

  it("skips malformed/unparseable entries without throwing", () => {
    const controlOut: (string | object)[] = [
      "not json {{{",
      42 as unknown as object,
      JSON.stringify({ response: { response: { updatedInput: { questions: [{ options: [{ label: "Ok" }] }] } } } }),
      JSON.stringify({ response: {} }), // well-formed JSON, but missing the nested shape entirely
    ];
    expect(() => recordedGateLabels(controlOut)).not.toThrow();
    expect(recordedGateLabels(controlOut)).toEqual(["Ok"]);
  });

  it("returns [] for undefined or empty input", () => {
    expect(recordedGateLabels(undefined)).toEqual([]);
    expect(recordedGateLabels([])).toEqual([]);
  });
});

// -------------------------------------------------------------------------------------------- //
// stampLabelProvenance
// -------------------------------------------------------------------------------------------- //

describe("stampLabelProvenance", () => {
  // The single most important assertion in this file: the stamp must record FILE order, not the
  // order labels were passed in. A reorder in the prose is only detectable later (checkLabelProvenance)
  // if the recorded baseline reflects where each label actually sat in the file — an
  // emission-order stamp would make every reorder invisible by construction.
  it("stamps labels in file order, not in the order passed in", () => {
    const dir = tmpDir("label-stamp-order-");
    writeFileSync(join(dir, "SKILL.md"), "Catalog: Billing, then Auth, then Audit.");
    // Passed in the OPPOSITE order from how they appear in the file.
    const stamp = stampLabelProvenance(["Audit", "Auth", "Billing"], [dir]);
    expect(stamp).toEqual([{ file: "SKILL.md", labels: ["Billing", "Auth", "Audit"] }]);
  });

  it("does not stamp a label that appears in no prose file (the paraphrase case)", () => {
    const dir = tmpDir("label-stamp-paraphrase-");
    writeFileSync(join(dir, "SKILL.md"), "Only Auth and Billing are mentioned here.");
    const stamp = stampLabelProvenance(["Auth", "Billing", "Invented Option"], [dir]);
    expect(stamp).toEqual([{ file: "SKILL.md", labels: ["Auth", "Billing"] }]);
  });

  it("returns undefined for empty labels or empty dirs", () => {
    const dir = tmpDir("label-stamp-empty-");
    writeFileSync(join(dir, "SKILL.md"), "Auth, Billing");
    expect(stampLabelProvenance([], [dir])).toBeUndefined();
    expect(stampLabelProvenance(["Auth"], [])).toBeUndefined();
  });

  it("only scans prose extensions — a label sitting only in a non-prose file is not stamped", () => {
    const dir = tmpDir("label-stamp-ext-");
    // "Auth" appears only in a binary-ish/non-prose file; "Billing" appears in a scanned .md file.
    writeFileSync(join(dir, "logo.png"), "Auth");
    writeFileSync(join(dir, "notes.bin"), "Auth");
    writeFileSync(join(dir, "SKILL.md"), "Billing is covered here.");
    const stamp = stampLabelProvenance(["Auth", "Billing"], [dir]);
    expect(stamp).toEqual([{ file: "SKILL.md", labels: ["Billing"] }]);
  });
});

// -------------------------------------------------------------------------------------------- //
// checkLabelProvenance
// -------------------------------------------------------------------------------------------- //

describe("checkLabelProvenance", () => {
  it("reports [] for unchanged prose — the most important negative case (no false positives)", () => {
    const dir = tmpDir("label-check-unchanged-");
    writeFileSync(join(dir, "SKILL.md"), "Catalog: Auth, Billing, Audit.");
    const stamp = stampLabelProvenance(["Auth", "Billing", "Audit"], [dir]);
    expect(checkLabelProvenance(stamp, [dir])).toEqual([]);
  });

  it("detects a pure reorder of the catalog and names both the recorded and current order", () => {
    const dir = tmpDir("label-check-reorder-");
    writeFileSync(join(dir, "SKILL.md"), "Catalog: Auth, Billing, Audit.");
    const stamp = stampLabelProvenance(["Auth", "Billing", "Audit"], [dir]);
    // Reorder the same three labels — nothing removed, nothing added.
    writeFileSync(join(dir, "SKILL.md"), "Catalog: Audit, Auth, Billing.");
    const drift = checkLabelProvenance(stamp, [dir]);
    expect(drift).toHaveLength(1);
    expect(drift[0]).toContain("reordered");
    expect(drift[0]).toContain("recorded [Auth, Billing, Audit]");
    expect(drift[0]).toContain("now [Audit, Auth, Billing]");
  });

  it("detects a removed label and names it", () => {
    const dir = tmpDir("label-check-removed-");
    writeFileSync(join(dir, "SKILL.md"), "Catalog: Auth, Billing, Audit.");
    const stamp = stampLabelProvenance(["Auth", "Billing", "Audit"], [dir]);
    writeFileSync(join(dir, "SKILL.md"), "Catalog: Auth, Audit."); // Billing removed
    const drift = checkLabelProvenance(stamp, [dir]);
    expect(drift).toHaveLength(1);
    expect(drift[0]).toContain("no longer in");
    expect(drift[0]).toContain('"Billing"');
  });

  // Pinning actual behaviour per the implementation comment: a changed-set finding short-circuits
  // (`continue`) before the order check runs for that file, so removal never ALSO triggers a
  // reorder complaint about the same file — that would be noise stacked on a real finding.
  it("does not also emit an order complaint for a file that already has a removal finding", () => {
    const dir = tmpDir("label-check-removed-no-reorder-");
    writeFileSync(join(dir, "SKILL.md"), "Catalog: Auth, Billing, Audit.");
    const stamp = stampLabelProvenance(["Auth", "Billing", "Audit"], [dir]);
    // Remove Billing AND reorder what remains — still must be exactly one finding (the removal).
    writeFileSync(join(dir, "SKILL.md"), "Catalog: Audit, Auth.");
    const drift = checkLabelProvenance(stamp, [dir]);
    expect(drift).toHaveLength(1);
    expect(drift[0]).toContain("no longer in");
    expect(drift.some((d) => d.includes("reordered"))).toBe(false);
  });

  it("reports [] when the stamp's source file no longer exists (another check's finding)", () => {
    const dir = tmpDir("label-check-missing-file-");
    writeFileSync(join(dir, "SKILL.md"), "Catalog: Auth, Billing.");
    const stamp = stampLabelProvenance(["Auth", "Billing"], [dir]);
    // Recreate a fresh dir with the same stamp referring to a file that was never written there —
    // simulates the file having vanished between record and check.
    const dir2 = tmpDir("label-check-missing-file-2-");
    expect(checkLabelProvenance(stamp, [dir2])).toEqual([]);
  });

  it("returns [] for undefined or empty stamp", () => {
    const dir = tmpDir("label-check-empty-");
    expect(checkLabelProvenance(undefined, [dir])).toEqual([]);
    expect(checkLabelProvenance([], [dir])).toEqual([]);
  });
});
