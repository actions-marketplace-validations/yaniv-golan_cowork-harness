import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Anti-drift tripwire: the `trace --view` enum lives in two places that must agree —
// src/cli.ts's TRACE_VIEWS array (what the CLI actually accepts) and docs/cli.md's trace row (what a
// user reading the docs believes is accepted). Neither is generated from the other, so a view
// added/renamed/removed in one and not the other silently rots. Source of truth is src/cli.ts;
// the module is NOT imported here (it has side effects on load) — its TRACE_VIEWS array literal
// (hoisted to module scope, above `HELP`, so the top-level HELP catalog, SUBCOMMAND_USAGE.trace, the
// no-target fail() usage string, and cmdTrace's runtime validator all interpolate this one literal —
// that pinning is now structural, not test-enforced; see test/cli-help.test.ts's "trace --help gives
// every view an explanation line" and "every trace --view list derives from TRACE_VIEWS") is
// regex-parsed out of the source text instead, same technique as the COMMANDS parse in
// test/cli-help.test.ts.

describe("trace --view enum ↔ README docs", () => {
  const src = readFileSync(resolve("src/cli.ts"), "utf8");
  const viewsIdx = src.indexOf("const TRACE_VIEWS = [");
  const viewsBlock = src.slice(viewsIdx, src.indexOf("]", viewsIdx));
  const cliViews = [...viewsBlock.matchAll(/"([^"]+)"/g)].map((m) => m[1]);

  const cliDoc = readFileSync(resolve("docs/cli.md"), "utf8");
  // The enum lives in the `trace` bullet under "Flags worth knowing". Anchor on that bullet rather
  // than on the first `--view` in the file: TWO other places carry a `--view` list, and matching
  // either would compare the wrong enum against TRACE_VIEWS.
  //   1. a quickstart snippet with a single view (`--view tools`), and
  //   2. the `diff` bullet, whose own `--view tools|transcript|artifacts|meta` is a DIFFERENT enum
  //      that happens to start with the same word.
  // Pipes are bare here. They were once backslash-escaped, which was correct while the enum sat in
  // a markdown TABLE cell (GFM's table parser consumes `\|`), but it moved to a list in 3.7.0 and
  // outside a table `\|` inside a code span publishes a literal backslash. Accept either form so a
  // future move back into a table does not silently break this guard.
  const traceBullet = cliDoc.split("\n").find((l) => l.startsWith("- `trace`:")) ?? "";
  const viewListMatch = traceBullet.match(/--view ([a-zA-Z0-9-]+(?:\\?\|[a-zA-Z0-9-]+)+)/);

  it("parsed a sane VIEWS set from src/cli.ts (guards against the array literal moving/renaming)", () => {
    expect(cliViews.length).toBeGreaterThan(3);
    expect(cliViews).toContain("tools");
    expect(cliViews).toContain("usage");
  });

  it("found the --view list documented in docs/cli.md's trace bullet", () => {
    expect(viewListMatch, "docs/cli.md's `- `trace`:` bullet no longer has a `--view a|b|c` list in the expected shape").not.toBeNull();
  });

  it("src/cli.ts VIEWS and README.md's documented --view list are the same set", () => {
    const readmeViews = (viewListMatch?.[1] ?? "").split(/\\?\|/);
    const missingFromReadme = cliViews.filter((v) => !readmeViews.includes(v));
    const extraInReadme = readmeViews.filter((v) => !cliViews.includes(v));
    expect(
      { missingFromReadme, extraInReadme },
      `README.md's trace --view list is out of sync with src/cli.ts VIEWS.\n` +
        `cli VIEWS: ${cliViews.join(", ")}\n` +
        `README --view: ${readmeViews.join(", ")}`,
    ).toEqual({ missingFromReadme: [], extraInReadme: [] });
  });
});
