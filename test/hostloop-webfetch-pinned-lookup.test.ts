import { describe, it, expect, afterAll, afterEach } from "vitest";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { pinnedRequest } from "../src/hostloop/workspace-handler.js";

/**
 * `pinnedRequest` is the DEFAULT rawFetch — the one every real web_fetch takes for a resolvable
 * (non-literal-IP) host, at the container tier as well as hostloop. The rest of the web_fetch suite
 * injects a `rawFetch` fake, so nothing had ever executed the function itself; one of those fakes is
 * even named "pinnedRequest-style fake" and asserts against a hand-built copy of its return value.
 * A shape bug in its `lookup` override therefore sat green for months behind tests that only ever
 * imitated its output — measured, not inferred: the full suite passes against the pre-fix source
 * with this file removed.
 *
 * These cases drive the real Node http stack. The override must answer BOTH callback shapes, because
 * which one Node asks for depends on `autoSelectFamily` — on by default since Node 20, which makes
 * `net.Socket.connect` request `{all: true}` and then read `addresses[0].address` off an array.
 * Answering that with the legacy `(err, address, family)` triple yields `Invalid IP address: undefined`.
 */
describe("pinnedRequest lookup override", () => {
  const servers: http.Server[] = [];

  const listen = async (): Promise<number> => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("pinned-ok");
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return (server.address() as AddressInfo).port;
  };

  // Belt-and-braces restore. The forced-off case restores in its own `finally`, but vitest's
  // `testTimeout` (30_000) races `pinnedRequest`'s own `AbortSignal.timeout(30000)`: if vitest wins,
  // the awaited promise is abandoned and that `finally` never runs, latching `false` for every later
  // test in this worker. A leaked `false` silently makes the other cases pass against PRE-FIX code —
  // the exact false-green this file exists to prevent.
  afterEach(() => net.setDefaultAutoSelectFamily(true));

  afterAll(async () => {
    for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
  });

  it("connects to the pinned address under the runtime's real autoSelectFamily default", async () => {
    // Guard the premise: if this ever defaults to false, the assertion below stops covering the
    // `{all: true}` shape and the test would pass for the wrong reason.
    expect(net.getDefaultAutoSelectFamily()).toBe(true);
    const port = await listen();
    const resp = await pinnedRequest(`http://localhost:${port}/`, ["127.0.0.1"]);
    expect(resp.status).toBe(200);
    await expect(resp.text()).resolves.toBe("pinned-ok");
  });

  it("still connects with autoSelectFamily forced OFF (the legacy triple shape)", async () => {
    const prev = net.getDefaultAutoSelectFamily();
    net.setDefaultAutoSelectFamily(false);
    try {
      const port = await listen();
      const resp = await pinnedRequest(`http://localhost:${port}/`, ["127.0.0.1"]);
      expect(resp.status).toBe(200);
      await expect(resp.text()).resolves.toBe("pinned-ok");
    } finally {
      net.setDefaultAutoSelectFamily(prev);
    }
  });

  it("never re-resolves the name — a host that only the pin can reach still connects", async () => {
    expect(net.getDefaultAutoSelectFamily()).toBe(true); // same premise guard as the first case
    const port = await listen();
    // `nonexistent.invalid` cannot resolve (RFC 2606). Reaching the server anyway proves the
    // override, not DNS, supplied the address.
    const resp = await pinnedRequest(`http://nonexistent.invalid:${port}/`, ["127.0.0.1"]);
    expect(resp.status).toBe(200);
    await expect(resp.text()).resolves.toBe("pinned-ok");
  });

  it("hands back EVERY vetted address, so a dead first entry still connects", async () => {
    expect(net.getDefaultAutoSelectFamily()).toBe(true);
    const port = await listen();
    // 192.0.2.0/24 is TEST-NET-1 (RFC 5737) — reserved and routed nowhere, so the first candidate
    // blackholes and only Happy Eyeballs' fallback to the second can complete the connection.
    // This is the one case that fails if the fix keeps the callback SHAPE but drops the
    // multi-address half: returning just `pinned[0]` hangs here until the 30s abort.
    const resp = await pinnedRequest(`http://localhost:${port}/`, ["192.0.2.1", "127.0.0.1"]);
    expect(resp.status).toBe(200);
    await expect(resp.text()).resolves.toBe("pinned-ok");
  });
});
