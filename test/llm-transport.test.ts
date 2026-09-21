import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { claudeCliComplete } from "../src/decide/llm-transport.js";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Drive the transport through a FAKE `claude` bin (via COWORK_HARNESS_CLAUDE_BIN) so the retry loop is
// exercised without a real model call. The fake's behavior is steered by env vars it reads at runtime; it
// records its invocation count to a counter file so a test can assert exactly how many times it was spawned.
let dir: string;
let binPath: string;
let counterPath: string;

const FAKE = `#!/bin/sh
n=$(cat "$FAKE_COUNTER" 2>/dev/null || echo 0)
n=$((n + 1))
echo "$n" > "$FAKE_COUNTER"
# Dump argv and stdin so a test can assert WHERE the prompt travels (stdin, never argv — a ps-readable
# argv leaks the prompt for the life of the child). Consume stdin unconditionally (even when no dump file
# is requested) so the parent's write+end never blocks on an unread pipe.
if [ -n "$FAKE_ARGV_FILE" ]; then printf '%s\\n' "$@" > "$FAKE_ARGV_FILE"; fi
if [ -n "$FAKE_STDIN_FILE" ]; then cat > "$FAKE_STDIN_FILE"; else cat > /dev/null; fi
case "$FAKE_MODE" in
  always-fail)
    echo '{"type":"result","is_error":true,"result":"fake operational error (on stdout, like claude -p)","modelUsage":{}}'
    exit 1 ;;
  succeed-after-1)
    if [ "$n" -le 1 ]; then echo '{"type":"result","is_error":true,"result":"transient blip","modelUsage":{}}'; exit 1; fi
    echo '{"type":"result","is_error":false,"result":"OK-ANSWER","modelUsage":{"claude-sonnet-5":{}}}'; exit 0 ;;
  timeout)
    sleep 30
    echo '{"type":"result","is_error":false,"result":"late","modelUsage":{"claude-sonnet-5":{}}}'; exit 0 ;;
  spew)
    yes 0123456789 | head -c 1000000 2>/dev/null
    exit 0 ;;
  malformed)
    echo 'not valid json'
    exit 0 ;;
  zero-models)
    echo '{"type":"result","is_error":false,"result":"OK-ANSWER","modelUsage":{}}'
    exit 0 ;;
  aux-model)
    # The REAL agent 2.1.275 shape for --model sonnet: an auxiliary haiku call beside the requested turn.
    echo '{"type":"result","is_error":false,"result":"OK-ANSWER","modelUsage":{"claude-haiku-4-5-20251001":{"inputTokens":897,"outputTokens":8},"claude-sonnet-5":{"inputTokens":2,"outputTokens":4}}}'
    exit 0 ;;
  aux-ambiguous)
    echo '{"type":"result","is_error":false,"result":"OK-ANSWER","modelUsage":{"claude-sonnet-5":{},"claude-sonnet-5[1m]":{}}}'
    exit 0 ;;
  aux-none)
    echo '{"type":"result","is_error":false,"result":"OK-ANSWER","modelUsage":{"claude-haiku-4-5-20251001":{},"claude-opus-5":{}}}'
    exit 0 ;;
  *)
    echo '{"type":"result","is_error":false,"result":"OK-ANSWER","modelUsage":{"claude-sonnet-5":{}}}'; exit 0 ;;
esac
`;

function invocations(): number {
  return existsSync(counterPath) ? Number(readFileSync(counterPath, "utf8").trim()) || 0 : 0;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "cowork-llm-transport-"));
  binPath = join(dir, "fake-claude.sh");
  counterPath = join(dir, "counter");
  writeFileSync(binPath, FAKE, { mode: 0o755 });
  process.env.COWORK_HARNESS_CLAUDE_BIN = binPath;
});

afterEach(() => {
  if (existsSync(counterPath)) rmSync(counterPath);
  delete process.env.FAKE_MODE;
  delete process.env.FAKE_COUNTER;
  delete process.env.FAKE_ARGV_FILE;
  delete process.env.FAKE_STDIN_FILE;
  delete process.env.COWORK_HARNESS_LLM_RETRIES;
  delete process.env.COWORK_HARNESS_LLM_TIMEOUT_MS;
  delete process.env.COWORK_HARNESS_LLM_MAX_BYTES;
  // The ENOENT test clobbers the bin path; restore it so later tests still spawn the fake.
  process.env.COWORK_HARNESS_CLAUDE_BIN = binPath;
});

afterAll(() => {
  delete process.env.COWORK_HARNESS_CLAUDE_BIN;
  rmSync(dir, { recursive: true, force: true });
});

describe("claudeCliComplete — retry transport", () => {
  it("retries a non-zero exit and resolves once the spawn succeeds", async () => {
    process.env.FAKE_MODE = "succeed-after-1";
    process.env.FAKE_COUNTER = counterPath;
    const out = await claudeCliComplete("q", "m");
    expect(out.text.trim()).toBe("OK-ANSWER");
    expect(out.model).toBe("claude-sonnet-5");
    expect(invocations()).toBe(2); // 1 transient failure + 1 success
  });

  it("propagates the resolved model from --output-format json's modelUsage (not the requested alias)", async () => {
    process.env.FAKE_COUNTER = counterPath;
    const out = await claudeCliComplete("q", "sonnet");
    expect(out.model).toBe("claude-sonnet-5");
  });

  it("a malformed JSON envelope on a clean exit fails loud (never silently swallowed)", async () => {
    process.env.FAKE_MODE = "malformed";
    process.env.FAKE_COUNTER = counterPath;
    await expect(claudeCliComplete("q", "m")).rejects.toThrow(/unparseable envelope/);
  });

  it("a clean exit with zero resolved models fails loud (never records an unknown/empty model)", async () => {
    process.env.FAKE_MODE = "zero-models";
    process.env.FAKE_COUNTER = counterPath;
    await expect(claudeCliComplete("q", "m")).rejects.toThrow(/modelUsage is empty/);
  });

  // Agent 2.1.275 (Desktop 2.2553.1) added an AUXILIARY haiku call in `-p` mode, so `modelUsage` carries
  // two keys where 2.1.260 carried one — bracketed live against both native binaries with the same prompt
  // and flags. The old "exactly 1 key" contract turned every critique evaluator pass and every
  // --decider-llm gate into an instrument failure on the new agent. The primary model is now the key that
  // RESOLVES the requested model; ambiguity still fails closed.
  describe("agent 2.1.275: an auxiliary model beside the requested one", () => {
    it("resolves a floating alias to the concrete id that carries it, and keeps the whole usage map", async () => {
      process.env.FAKE_MODE = "aux-model";
      process.env.FAKE_COUNTER = counterPath;
      const r = await claudeCliComplete("q", "sonnet");
      expect(r.text).toBe("OK-ANSWER");
      expect(r.model).toBe("claude-sonnet-5"); // never the haiku side-call, never the alias
      // The auxiliary call is real spend — it must not vanish from cost accounting.
      expect(Object.keys(r.usage ?? {}).sort()).toEqual(["claude-haiku-4-5-20251001", "claude-sonnet-5"]);
    });

    it("resolves an exact concrete id the same way", async () => {
      process.env.FAKE_MODE = "aux-model";
      process.env.FAKE_COUNTER = counterPath;
      expect((await claudeCliComplete("q", "claude-sonnet-5")).model).toBe("claude-sonnet-5");
    });

    it("two keys that BOTH resolve the request is still a contract break (fails closed)", async () => {
      process.env.FAKE_MODE = "aux-ambiguous";
      process.env.FAKE_COUNTER = counterPath;
      await expect(claudeCliComplete("q", "sonnet")).rejects.toThrow(/2 of them resolve the requested model "sonnet"/);
    });

    it("two keys and NEITHER resolves the request is a contract break (the requested model is not what ran)", async () => {
      process.env.FAKE_MODE = "aux-none";
      process.env.FAKE_COUNTER = counterPath;
      await expect(claudeCliComplete("q", "sonnet")).rejects.toThrow(/0 of them resolve the requested model "sonnet"/);
    });

    it("alias matching is by dash-segment, not substring", async () => {
      process.env.FAKE_MODE = "aux-none"; // keys: claude-haiku-4-5-20251001, claude-opus-5
      process.env.FAKE_COUNTER = counterPath;
      // "opus" is a segment of claude-opus-5 → resolves; "op" is a substring only → must NOT.
      expect((await claudeCliComplete("q", "opus")).model).toBe("claude-opus-5");
      await expect(claudeCliComplete("q", "op")).rejects.toThrow(/0 of them resolve/);
    });
  });

  it("exhausts the bounded retries then fails loud, with the child's STDOUT folded into the message", async () => {
    process.env.FAKE_MODE = "always-fail";
    process.env.FAKE_COUNTER = counterPath;
    process.env.COWORK_HARNESS_LLM_RETRIES = "2";
    await expect(claudeCliComplete("q", "m")).rejects.toThrow(/exited 1.*stdout: fake operational error/s);
    expect(invocations()).toBe(3); // 1 initial + 2 retries
  });

  it("COWORK_HARNESS_LLM_RETRIES=0 disables retry (single attempt)", async () => {
    process.env.FAKE_MODE = "always-fail";
    process.env.FAKE_COUNTER = counterPath;
    process.env.COWORK_HARNESS_LLM_RETRIES = "0";
    await expect(claudeCliComplete("q", "m")).rejects.toThrow(/exited 1/);
    expect(invocations()).toBe(1);
  });

  it("an unparseable retry count falls back to the default (does NOT silently disable)", async () => {
    process.env.FAKE_MODE = "always-fail";
    process.env.FAKE_COUNTER = counterPath;
    process.env.COWORK_HARNESS_LLM_RETRIES = "not-a-number";
    await expect(claudeCliComplete("q", "m")).rejects.toThrow(/exited 1/);
    expect(invocations()).toBe(3); // default 2 retries, not 0
  });

  it("does NOT retry a timeout (a hung child that ate the budget is not a quick transient)", async () => {
    process.env.FAKE_MODE = "timeout";
    process.env.FAKE_COUNTER = counterPath;
    process.env.COWORK_HARNESS_LLM_RETRIES = "2";
    // The fake sleeps 30s; the timeout trips at 1s (wide margin so a slow/loaded CI box still records the
    // counter write — the fake's first action — before SIGKILL). The kill ends the test in ~1s, not 30s.
    process.env.COWORK_HARNESS_LLM_TIMEOUT_MS = "1000";
    await expect(claudeCliComplete("q", "m")).rejects.toThrow(/timed out/);
    expect(invocations()).toBe(1); // spawned once, NOT retried
  });

  it("a timeout error names COWORK_HARNESS_LLM_TIMEOUT_MS as the mitigation", async () => {
    process.env.FAKE_MODE = "timeout";
    process.env.FAKE_COUNTER = counterPath;
    process.env.COWORK_HARNESS_LLM_TIMEOUT_MS = "1000";
    await expect(claudeCliComplete("q", "m")).rejects.toThrow(/COWORK_HARNESS_LLM_TIMEOUT_MS/);
  });

  it("a maxBytes overflow names COWORK_HARNESS_LLM_MAX_BYTES as the mitigation", async () => {
    process.env.FAKE_MODE = "spew";
    process.env.FAKE_COUNTER = counterPath;
    process.env.COWORK_HARNESS_LLM_MAX_BYTES = "1000";
    await expect(claudeCliComplete("q", "m")).rejects.toThrow(/COWORK_HARNESS_LLM_MAX_BYTES/);
  });

  it("a spawn ENOENT names the PATH / COWORK_HARNESS_CLAUDE_BIN mitigation", async () => {
    process.env.COWORK_HARNESS_CLAUDE_BIN = join(dir, "does-not-exist");
    await expect(claudeCliComplete("q", "m")).rejects.toThrow(/PATH|COWORK_HARNESS_CLAUDE_BIN/);
  });

  it("delivers the prompt on STDIN, never on argv (argv is world-readable via `ps`)", async () => {
    process.env.FAKE_COUNTER = counterPath;
    const argvFile = join(dir, "argv.out");
    const stdinFile = join(dir, "stdin.out");
    process.env.FAKE_ARGV_FILE = argvFile;
    process.env.FAKE_STDIN_FILE = stdinFile;
    const secret = "SECRET-PROMPT-CONTENTS-9f3a";
    await claudeCliComplete(secret, "m");
    const argv = readFileSync(argvFile, "utf8");
    const stdin = readFileSync(stdinFile, "utf8");
    expect(stdin).toContain(secret);
    expect(argv).not.toContain(secret);
  });

  it("a malformed COWORK_HARNESS_LLM_TIMEOUT_MS is rejected loud, not silently reverted", async () => {
    process.env.FAKE_COUNTER = counterPath;
    process.env.COWORK_HARNESS_LLM_TIMEOUT_MS = "5m";
    const warnings: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      warnings.push(String(chunk));
      return true;
    });
    try {
      await claudeCliComplete("q", "m");
    } finally {
      spy.mockRestore();
    }
    expect(warnings.join("")).toMatch(/COWORK_HARNESS_LLM_TIMEOUT_MS.*not a positive number/s);
  });

  it("a malformed COWORK_HARNESS_LLM_MAX_BYTES (explicit 0) is rejected loud, not silently reverted", async () => {
    process.env.FAKE_COUNTER = counterPath;
    process.env.COWORK_HARNESS_LLM_MAX_BYTES = "0";
    const warnings: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      warnings.push(String(chunk));
      return true;
    });
    try {
      await claudeCliComplete("q", "m");
    } finally {
      spy.mockRestore();
    }
    expect(warnings.join("")).toMatch(/COWORK_HARNESS_LLM_MAX_BYTES.*not a positive number/s);
  });
});
