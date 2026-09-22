import { describe, it, expect } from "vitest";
import { parseMessage } from "../src/agent/session.js";
import { loadHookFrames } from "./helpers/hook-frames.js";

describe("recorded Stop-hook frames reach contextEvents unchanged", () => {
  const frames = loadHookFrames();

  it("the fixture carries a Stop hook_response with exit_code 2 and one with exit_code 0 (block, then pass)", () => {
    const stop = frames.filter((f) => f.subtype === "hook_response" && f.hook_event === "Stop");
    expect(stop.map((f) => f.exit_code)).toEqual(expect.arrayContaining([2, 0]));
  });

  it("parseMessage surfaces every hook_response as a system_event keeping hook_event, exit_code and outcome", () => {
    const events = frames.flatMap((f) => parseMessage(f));
    const responses = events.filter((e) => e.type === "system_event" && e.subtype === "hook_response");
    expect(responses.length).toBe(frames.filter((f) => f.subtype === "hook_response").length);
    const block = responses.find((e) => e.type === "system_event" && e.data.hook_event === "Stop" && e.data.exit_code === 2);
    expect(block, "the blocking Stop frame must survive translation with its exit_code").toBeDefined();
    expect(block && block.type === "system_event" && block.data.outcome).toBe("error");
  });

  it("no frame carries any event but Stop — the probe declares only a Stop hook, so a 'wrong event' test is real", () => {
    expect(new Set(frames.map((f) => f.hook_event))).toEqual(new Set(["Stop"]));
  });
});
