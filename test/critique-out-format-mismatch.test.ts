import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs as parseCritiqueArgs } from "../src/critique/command.js";
import * as io from "../src/io.js";

// `--out foo.json` writes whatever `--output-format` says, and that defaults to TEXT. A downstream
// `json.load()` then fails with "Expecting value: line 1 column 1", which reads as a corrupt or missing
// report rather than a format mismatch — a consumer hit exactly that.
//
// The fix is a warning at ARGUMENT-PARSE time, not extension inference. Two reasons it is not
// inference: a filename is not proof of intent, and silently changing what an existing
// `--out foo.json` writes would break a script that already parses the text. And one reason parse time
// specifically: the reported cost was a four-workload run found unparseable AFTER it was paid for.

const warns: string[] = [];
function capture() {
  warns.length = 0;
  return vi.spyOn(io, "warn").mockImplementation((m: string) => void warns.push(m));
}
afterEach(() => vi.restoreAllMocks());

const base = ["./skill", "--prompt", "do the thing"];

describe("critique --out / --output-format mismatch", () => {
  it("warns when --out is .json and the format is the text DEFAULT, naming the flag to add", () => {
    capture();
    parseCritiqueArgs([...base, "--out", "report.json"]);
    const w = warns.join("\n");
    expect(w).toMatch(/--out report\.json looks like json/);
    expect(w).toMatch(/\(the default\)/); // says the format was not chosen, it was inherited
    expect(w).toMatch(/Pass --output-format json/);
  });

  it("warns when the two were both set and disagree, without calling the format a default", () => {
    capture();
    parseCritiqueArgs([...base, "--out", "report.json", "--output-format", "text"]);
    const w = warns.join("\n");
    expect(w).toMatch(/looks like json/);
    expect(w).not.toMatch(/\(the default\)/);
  });

  it("warns the other way too — a .md/.txt target with --output-format json", () => {
    capture();
    parseCritiqueArgs([...base, "--out", "report.md", "--output-format", "json"]);
    expect(warns.join("\n")).toMatch(/looks like text/);
  });

  it("is silent when they agree, and when the extension says nothing", () => {
    capture();
    parseCritiqueArgs([...base, "--out", "report.json", "--output-format", "json"]);
    parseCritiqueArgs([...base, "--out", "report.txt"]);
    parseCritiqueArgs([...base, "--out", "report"]); // no extension — nothing to infer, so nothing to warn about
    parseCritiqueArgs([...base, "--out", "report.critique"]);
    expect(warns).toEqual([]);
  });

  it("does NOT change what gets written — the warning is the whole behaviour change", () => {
    capture();
    // If a later refactor "helpfully" infers the format from the extension, this reds: an existing
    // script parsing the text report out of a .json path would silently start getting JSON.
    expect(parseCritiqueArgs([...base, "--out", "report.json"]).outputFormat).toBe("text");
  });
});

describe("the cost guidance no longer states one ratio unconditionally", () => {
  const help = readFileSync(resolve("src/critique/command.ts"), "utf8");
  const docs = readFileSync(resolve("docs/critique.md"), "utf8");

  // Measured: on a trivial probe the evaluator passes are ~3/4 of spend; on a real document-analysis
  // run it inverts (task ~61%, evaluator ~30%). Stating the first unconditionally sent a fleet operator
  // to swap --evaluator-model — trading a verified injection-resistance property for at most a third of
  // the advertised saving.
  it("the --help text names both regimes, not just the trivial-probe one", () => {
    // Both halves must be present: the trivial-probe ratio is not wrong, it was just stated as if it
    // were the only regime.
    expect(help).toMatch(/trivial probe[\s\S]{0,80}~3\/4/);
    expect(help).toMatch(/INVERTS/);
    expect(help).toMatch(/task turn ~61%/);
  });

  it("docs/critique.md says the same, and points at the per-run split", () => {
    expect(docs).toMatch(/depends on the skill/);
    expect(docs).toMatch(/inverts/i);
    expect(docs).toMatch(/costUsd/);
  });
});
