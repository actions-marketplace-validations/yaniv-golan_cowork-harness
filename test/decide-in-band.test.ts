import { describe, it, expect } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

// `cowork-harness decide` exists to try an answer channel in ~2s without paying for a run — and it was the
// one channel it could not try. It rejected --decider-dir outright, while its help block sat directly under
// the "In-band gate plumbing (for --decider-dir)" header. That gap is why agents that DO find the flag go on
// to hand-roll the req-N.json/resp-N.json protocol: nothing lets them watch it work once.
//
// These tests pin the rehearsal end-to-end, because a rehearsal that diverges from the real channel is worse
// than none. `decide` uses the SAME fileChannel + ExternalDecider as a real run, so the fresh-empty-dir
// refusal and the wire shape below are the production guards, not mocks of them.
const CLI = resolve("dist/cli.js");
const haveCli = existsSync(CLI);
if (!haveCli) {
  // Loud: a skipped channel test must never be mistaken for a passing one.
  // eslint-disable-next-line no-console
  console.warn("dist/cli.js missing — decide --decider-dir tests SKIPPED (run `npm run build` first)");
}

const fresh = () => mkdtempSync(join(tmpdir(), "decide-inband-"));
const run = (args: string[]) => {
  const r = spawnSync("node", [CLI, ...args], { encoding: "utf8" });
  return { code: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
};

describe.runIf(haveCli)("decide --decider-dir — usage guards", () => {
  it("refuses a dirty dir, with the same message a real run gives (exit 2)", () => {
    const d = fresh();
    writeFileSync(join(d, "req-1.json"), "{}\n");
    const r = run(["decide", "--decider-dir", d]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("use a fresh, empty directory per run");
  });

  it.each([
    [["--decider-cmd", "cat"], "one terminal channel"],
    [["--decider-llm"], "one terminal decider"],
    [["--answer", "q=c"], "the scripted rules would never be used"],
  ])("rejects pairing with %s (exit 2)", (extra, needle) => {
    const r = run(["decide", "--decider-dir", fresh(), ...(extra as string[])]);
    expect(r.code).toBe(2);
    expect(r.out).toContain(needle);
  });

  it("rejects a flag-looking value instead of swallowing the next flag", () => {
    const r = run(["decide", "--decider-dir", "--question", "hi"]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("--decider-dir: missing value");
  });

  it("is listed as a configurable decider when none is passed", () => {
    const r = run(["decide"]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("--decider-dir <dir>");
  });
});

describe.runIf(haveCli)("decide --decider-dir — the round trip", () => {
  it("writes a real gate, blocks, and resolves with the label answered via `answer`", async () => {
    const d = fresh();
    const child = spawn("node", [CLI, "decide", "--decider-dir", d, "--output-format", "json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    } as never);
    let stdout = "";
    child.stdout!.on("data", (c: Buffer) => (stdout += c.toString()));

    // Wait for req-1.json — the harness writes it atomically, so seeing the name means it is complete.
    const deadline = Date.now() + 30_000;
    while (!readdirSync(d).includes("req-1.json")) {
      if (Date.now() > deadline) {
        child.kill();
        throw new Error("decide never emitted req-1.json");
      }
      await new Promise((r) => setTimeout(r, 50));
    }

    // `gates` must surface it with a seq, without the standard result envelope (raw protocol lines).
    const gates = run(["gates", d]);
    expect(gates.code).toBe(0);
    const streamed = JSON.parse(gates.out.trim().split("\n")[0]);
    expect(streamed.seq).toBe(1);
    expect(streamed.kind).toBe("question");

    // Answer via the subcommand — NOT by hand-writing resp-1.json. That is the behaviour being taught.
    const label = streamed.questions[0].options[1].label;
    expect(run(["answer", d, "--gate", "1", "--choose", label]).code).toBe(0);

    const exit = await new Promise<number>((res) => child.on("close", (c) => res(c ?? -1)));
    expect(exit).toBe(0);
    const envelope = JSON.parse(stdout.trim());
    expect(envelope).toMatchObject({ command: "decide", ok: true, answer: label, by: "in-band" });
  }, 60_000);

  it("keeps stdout clean — the teaching lines go to stderr, so it composes with --output-format json", async () => {
    // Regression guard: the two `gates`/`answer` hints printed on this path must never reach stdout,
    // or every JSON consumer of `decide` breaks.
    const d = fresh();
    const child = spawn("node", [CLI, "decide", "--decider-dir", d, "--output-format", "json"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    const deadline = Date.now() + 30_000;
    while (!readdirSync(d).includes("req-1.json")) {
      if (Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(stdout).toBe("");
    expect(stderr).toContain("cowork-harness gates");
    expect(stderr).toContain("cowork-harness answer");
    child.kill();
  }, 60_000);
});
