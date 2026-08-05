// THIS LANE SPENDS REAL MONEY, AND THE OBVIOUS PRE-CHECK DOES NOT PROVE OTHERWISE.
//
// The live suites drive the real agent binary against real inference. The natural way to convince
// yourself a run is free — "no CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY in the environment, so the
// token-gated cases will skip" — is WRONG on a developer machine: at hostloop fidelity the agent
// self-sources credentials from the macOS Keychain, so the lane bills with an entirely empty env.
// That exact reasoning was used to authorise a run, and it cost real money (measured: ~$0.24 for one
// probe). An env-var check is the wrong oracle; there is no cheap correct one, which is why this
// prints instead of predicting.
//
// A `globalSetup` (not `setupFiles`) so it appears ONCE per run rather than per worker, and so it
// fires for `npx vitest run --config vitest.config.live.ts` too — not only `npm run test:live`. It
// deliberately does NOT gate execution behind an opt-in variable: CI's boundary job runs this lane,
// and a required flag would either break that job or be pre-set there and thus never seen by the
// person who needs it.
export default function liveLaneNotice(): void {
  // stderr, not stdout: the repo's convention is machine output on stdout, human output on stderr,
  // and a notice must never contaminate a `--output-format json` consumer downstream.
  process.stderr.write(
    [
      "",
      "┌─ LIVE LANE ─────────────────────────────────────────────────────────────────┐",
      "│ These suites run REAL inference against the staged agent and CAN BILL YOU.   │",
      "│                                                                             │",
      "│ An empty environment is NOT proof this is free: at hostloop fidelity the    │",
      "│ agent self-sources credentials (macOS Keychain), so it bills with no         │",
      "│ CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY set anywhere.                    │",
      "│                                                                             │",
      "│ Token-free lanes: `npm test` (unit) · `cowork-harness replay` (cassettes).   │",
      "└─────────────────────────────────────────────────────────────────────────────┘",
      "",
    ].join("\n"),
  );
}
