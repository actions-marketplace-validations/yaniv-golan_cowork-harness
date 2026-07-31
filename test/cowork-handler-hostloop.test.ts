import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCoworkHandlerHostLoop } from "../src/hostloop/cowork-handler-hostloop.js";

// Token-free, filesystem-only coverage for the hostloop-shaped `cowork` sdk-MCP server: pass-through
// present_files (no copy), the same tool name/schema/description contract as the container handler, and
// — the security-critical part — the containment/symlink/regular-file guards, one test per escape vector
// (`..` traversal, a symlink pointing outside every allowed root, and an absolute path outside every
// allowed root altogether).

function makeRoots() {
  const root = mkdtempSync(join(tmpdir(), "cowork-handler-hostloop-"));
  const outputsDir = join(root, "session", "mnt", "outputs");
  mkdirSync(outputsDir, { recursive: true });
  return { root, outputsDir };
}

type ToolsCallResult = {
  result?: { content: { type: string; text: string }[] };
  notify?: string;
  error?: { code: number; message: string };
};

async function callPresentFiles(h: ReturnType<typeof makeCoworkHandlerHostLoop>, filePaths: string[]): Promise<ToolsCallResult> {
  return (await h("cowork", {
    method: "tools/call",
    params: { name: "present_files", arguments: { files: filePaths.map((file_path) => ({ file_path })) } },
  })) as ToolsCallResult;
}

describe("makeCoworkHandlerHostLoop", () => {
  it("tools/list exposes present_files with the SAME name/schema/alwaysLoad as the container handler", async () => {
    const { outputsDir } = makeRoots();
    const h = makeCoworkHandlerHostLoop({ allowedRoots: [outputsDir] });
    const out: any = await h("cowork", { method: "tools/list" });
    const tool = out.result.tools.find((t: any) => t.name === "present_files");
    expect(tool).toBeDefined();
    expect(tool.inputSchema.required).toEqual(["files"]);
    expect(tool.inputSchema.properties.files.items.required).toEqual(["file_path"]);
    expect(tool._meta["anthropic/alwaysLoad"]).toBe(true);
  });

  it("passes a file already under an allowed root straight through: no copy, promoted:false, from===to", async () => {
    const { outputsDir } = makeRoots();
    const filePath = join(outputsDir, "report.md");
    writeFileSync(filePath, "hello");
    const events: any[] = [];
    const h = makeCoworkHandlerHostLoop({ allowedRoots: [outputsDir], onPresent: (p) => events.push(p) });

    const out = await callPresentFiles(h, [filePath]);

    expect(out.result?.content).toEqual([{ type: "text", text: filePath }]);
    expect(events).toEqual([{ from: filePath, to: filePath, promoted: false }]);
    // no notify — nothing was copied, there is nothing to warn the model about
    expect(out.notify).toBeUndefined();
  });

  it("accepts a file under a SECOND allowed root (a connected-folder mount), not just the first", async () => {
    const { outputsDir, root } = makeRoots();
    const folderDir = join(root, "connected-folder");
    mkdirSync(folderDir, { recursive: true });
    const filePath = join(folderDir, "deck.pdf");
    writeFileSync(filePath, "binary-ish");
    const h = makeCoworkHandlerHostLoop({ allowedRoots: [outputsDir, folderDir] });

    const out = await callPresentFiles(h, [filePath]);
    expect(out.result?.content).toEqual([{ type: "text", text: filePath }]);
  });

  it("multiple valid files in one call all pass through, each with its own from===to entry", async () => {
    const { outputsDir } = makeRoots();
    const a = join(outputsDir, "a.md");
    const b = join(outputsDir, "b.md");
    writeFileSync(a, "A");
    writeFileSync(b, "B");
    const events: any[] = [];
    const h = makeCoworkHandlerHostLoop({ allowedRoots: [outputsDir], onPresent: (p) => events.push(p) });

    const out = await callPresentFiles(h, [a, b]);
    expect(out.result?.content).toEqual([
      { type: "text", text: a },
      { type: "text", text: b },
    ]);
    expect(events).toEqual([
      { from: a, to: a, promoted: false },
      { from: b, to: b, promoted: false },
    ]);
  });

  it("a malformed entry missing file_path returns an invalid-params error instead of throwing", async () => {
    const { outputsDir } = makeRoots();
    const h = makeCoworkHandlerHostLoop({ allowedRoots: [outputsDir] });
    const out = (await h("cowork", {
      method: "tools/call",
      params: { name: "present_files", arguments: { files: [{}] } },
    })) as ToolsCallResult;

    expect(out.result).toBeUndefined();
    expect(out.error).toEqual({ code: -32602, message: "present_files: each file requires a string file_path" });
  });

  it("a non-array files argument returns an invalid-params error instead of throwing", async () => {
    const { outputsDir } = makeRoots();
    const h = makeCoworkHandlerHostLoop({ allowedRoots: [outputsDir] });
    const out = (await h("cowork", {
      method: "tools/call",
      params: { name: "present_files", arguments: { files: "not-an-array" } },
    })) as ToolsCallResult;

    expect(out.result).toBeUndefined();
    expect(out.error).toEqual({ code: -32602, message: "present_files: files must be an array" });
  });

  // --- escape vectors: each must take the whole-call error branch, never a silent skip -------------

  it("escape vector: '..' path traversal outside every allowed root is rejected, nothing returned", async () => {
    const { outputsDir, root } = makeRoots();
    writeFileSync(join(root, "session", "secret.txt"), "TOP SECRET");
    const events: any[] = [];
    const h = makeCoworkHandlerHostLoop({ allowedRoots: [outputsDir], onPresent: (p) => events.push(p) });
    // outputsDir = <root>/session/mnt/outputs — three ".." lexically lands on secret.txt in <root>/session
    const traversal = join(outputsDir, "..", "..", "secret.txt");

    const out = await callPresentFiles(h, [traversal]);

    expect(out.result).toBeUndefined();
    expect(out.error).toBeDefined();
    expect(out.error?.message).toContain("not accessible on the user's computer");
    expect(events).toEqual([]); // no onPresent fired for a rejected path — never a silent skip
  });

  it("escape vector: a symlink pointing outside every allowed root is rejected even though its target exists", async () => {
    const { outputsDir, root } = makeRoots();
    const outsideTarget = join(root, "outside-secret.txt");
    writeFileSync(outsideTarget, "OUTSIDE CONTENT");
    const linkPath = join(outputsDir, "link-out.txt");
    symlinkSync(outsideTarget, linkPath);
    const events: any[] = [];
    const h = makeCoworkHandlerHostLoop({ allowedRoots: [outputsDir], onPresent: (p) => events.push(p) });

    const out = await callPresentFiles(h, [linkPath]);

    expect(out.result).toBeUndefined();
    expect(out.error).toBeDefined();
    expect(out.error?.message).toContain(linkPath);
    expect(events).toEqual([]);
  });

  it("escape vector: a symlink INSIDE an allowed root whose target resolves inside an allowed root is STILL rejected (guards the named node, not just its target)", async () => {
    const { outputsDir } = makeRoots();
    const realFile = join(outputsDir, "real.txt");
    writeFileSync(realFile, "real content");
    const linkPath = join(outputsDir, "link-to-real.txt");
    symlinkSync(realFile, linkPath);
    const h = makeCoworkHandlerHostLoop({ allowedRoots: [outputsDir] });

    const out = await callPresentFiles(h, [linkPath]);

    expect(out.result).toBeUndefined();
    expect(out.error).toBeDefined();
  });

  it("escape vector: an absolute path outside every allowed root (no relative trickery) is rejected", async () => {
    const { outputsDir } = makeRoots();
    const h = makeCoworkHandlerHostLoop({ allowedRoots: [outputsDir] });

    const out = await callPresentFiles(h, ["/etc/passwd"]);

    expect(out.result).toBeUndefined();
    expect(out.error).toBeDefined();
    expect(out.error?.message).toContain("/etc/passwd");
  });

  it("a directory (not a regular file) is rejected", async () => {
    const { outputsDir } = makeRoots();
    const subdir = join(outputsDir, "subdir");
    mkdirSync(subdir);
    const h = makeCoworkHandlerHostLoop({ allowedRoots: [outputsDir] });

    const out = await callPresentFiles(h, [subdir]);

    expect(out.result).toBeUndefined();
    expect(out.error).toBeDefined();
  });

  it("a non-existent path is rejected, not thrown", async () => {
    const { outputsDir } = makeRoots();
    const h = makeCoworkHandlerHostLoop({ allowedRoots: [outputsDir] });

    const out = await callPresentFiles(h, [join(outputsDir, "does-not-exist.txt")]);

    expect(out.result).toBeUndefined();
    expect(out.error).toBeDefined();
  });

  it("a mixed valid+invalid batch aborts the WHOLE call — the valid file is not silently presented alone", async () => {
    const { outputsDir } = makeRoots();
    const good = join(outputsDir, "good.md");
    writeFileSync(good, "ok");
    const h = makeCoworkHandlerHostLoop({ allowedRoots: [outputsDir] });

    const out = await callPresentFiles(h, [good, "/etc/passwd"]);

    expect(out.result).toBeUndefined();
    expect(out.error).toBeDefined();
    expect(out.error?.message).toContain("/etc/passwd");
  });

  it("nothing is ever copied anywhere — the tier has no promotion path at all", async () => {
    const { outputsDir } = makeRoots();
    const filePath = join(outputsDir, "deliverable.md");
    writeFileSync(filePath, "content");
    const h = makeCoworkHandlerHostLoop({ allowedRoots: [outputsDir] });

    await callPresentFiles(h, [filePath]);

    // outputsDir's only entry is the ORIGINAL file — nothing new appeared (e.g. a renamed/collision-safe copy).
    expect(readdirSync(outputsDir)).toEqual(["deliverable.md"]);
  });
});
