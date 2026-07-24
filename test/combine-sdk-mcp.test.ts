import { describe, it, expect } from "vitest";
import { combineSdkMcp, type SdkMcp } from "../src/agent/session.js";
import { BoundaryError } from "../src/errors.js";

// Token-free coverage for the A2 `combineSdkMcp` helper: server-name routing across multiple bundles,
// `servers` concatenation, the no-handler-registered fallback shape, and that a sub-handler's own thrown
// error propagates UNCHANGED (not swallowed/reshaped).

function bundle(name: string, handle: SdkMcp["handle"]): SdkMcp {
  return { servers: [name], handle };
}

describe("combineSdkMcp", () => {
  it("concatenates servers from every bundle, in order", () => {
    const combined = combineSdkMcp(
      bundle("a", () => ({ result: {} })),
      bundle("b", () => ({ result: {} })),
      bundle("c", () => ({ result: {} })),
    );
    expect(combined.servers).toEqual(["a", "b", "c"]);
  });

  it("routes a call to the bundle that declared the server name", async () => {
    const combined = combineSdkMcp(
      bundle("cowork", () => ({ result: { from: "cowork" } })),
      bundle("skills", () => ({ result: { from: "skills" } })),
      bundle("plugins", () => ({ result: { from: "plugins" } })),
    );
    expect(await combined.handle("skills", { method: "tools/list" })).toEqual({ result: { from: "skills" } });
    expect(await combined.handle("plugins", { method: "tools/list" })).toEqual({ result: { from: "plugins" } });
    expect(await combined.handle("cowork", { method: "tools/list" })).toEqual({ result: { from: "cowork" } });
  });

  it("a server name no bundle declared gets a 'no handler configured' JSON-RPC error, not a throw", async () => {
    const combined = combineSdkMcp(bundle("cowork", () => ({ result: {} })));
    const out = await combined.handle("unknown-server", { method: "tools/list" });
    expect("error" in out).toBe(true);
    expect((out as { error: { code: number; message: string } }).error.code).toBe(-32601);
  });

  it("a sub-handler's own rejection propagates unchanged (not swallowed or reshaped)", async () => {
    const boom = new Error("sub-handler exploded");
    const combined = combineSdkMcp(
      bundle("skills", async () => {
        throw boom;
      }),
    );
    await expect(combined.handle("skills", { method: "tools/list" })).rejects.toBe(boom);
  });

  it("a sub-handler's own error result (not a throw) passes through unchanged", async () => {
    const combined = combineSdkMcp(bundle("skills", () => ({ error: { code: -32602, message: "bad args" } })));
    const out = await combined.handle("skills", { method: "tools/call" });
    expect(out).toEqual({ error: { code: -32602, message: "bad args" } });
  });

  // A wiring mistake (two bundles claiming one name) must fail LOUD at compose time: silently shadowing
  // one handler would also double the name in `sdkMcpServers`. It throws from inside
  // spawnContainer/spawnHostLoop, so it is a typed BoundaryError (clean, no stack trace) rather than a
  // bare Error surfacing as an unclassified spawn crash.
  it("throws a typed BoundaryError on a duplicate server name", () => {
    const dup = () =>
      combineSdkMcp(
        bundle("skills", () => ({})),
        bundle("skills", () => ({})),
      );
    expect(dup).toThrow(BoundaryError);
    expect(dup).toThrow(/duplicate sdkMcp server name "skills"/);
  });

  it("does not false-positive the duplicate guard across distinct names", () => {
    expect(() =>
      combineSdkMcp(
        bundle("skills", () => ({})),
        bundle("plugins", () => ({})),
      ),
    ).not.toThrow();
  });
});
